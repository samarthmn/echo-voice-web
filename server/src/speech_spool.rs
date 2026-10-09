//! Per-job encrypted native PCM. The random key is delivered over the owned
//! anonymous stdin pipe only and dies with the job; it is never a library key.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use rand::{rngs::OsRng, RngCore};
use std::path::Path;
use tokio::io::AsyncWriteExt;
use zeroize::Zeroizing;

pub const BLOCK: usize = 65_536;
pub struct Writer {
    file: tokio::fs::File,
    cipher: Aes256Gcm,
    key: Zeroizing<[u8; 32]>,
    index: u64,
    bytes: usize,
    pending: Zeroizing<Vec<u8>>,
}

impl Writer {
    pub async fn create(path: &Path) -> std::io::Result<Self> {
        let mut key = Zeroizing::new([0; 32]);
        OsRng.fill_bytes(key.as_mut());
        let cipher = Aes256Gcm::new_from_slice(key.as_ref()).unwrap();
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(path).await?;
        file.write_all(b"ECHOPCM1").await?;
        Ok(Self {
            file,
            cipher,
            key,
            index: 0,
            bytes: 0,
            pending: Zeroizing::new(Vec::with_capacity(BLOCK)),
        })
    }
    pub async fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let count = (BLOCK - self.pending.len()).min(remaining.len());
            self.pending.extend_from_slice(&remaining[..count]);
            self.bytes += count;
            remaining = &remaining[count..];
            if self.pending.len() == BLOCK {
                self.seal().await?;
            }
        }
        Ok(())
    }
    async fn seal(&mut self) -> std::io::Result<()> {
        if !self.pending.is_empty() {
            let block = self.pending.as_slice();
            let mut binding = [0u8; 12];
            binding[..8].copy_from_slice(&self.index.to_le_bytes());
            binding[8..].copy_from_slice(&(block.len() as u32).to_le_bytes());
            let mut nonce = [0; 12];
            nonce[4..].copy_from_slice(&self.index.to_le_bytes());
            let encrypted = self
                .cipher
                .encrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: block,
                        aad: &binding,
                    },
                )
                .map_err(|_| std::io::Error::other("Native audio encryption failed."))?;
            self.file.write_all(&binding[8..]).await?;
            self.file.write_all(&encrypted).await?;
            self.index += 1;
            use zeroize::Zeroize;
            self.pending.zeroize();
        }
        Ok(())
    }
    pub async fn finish(mut self) -> std::io::Result<(Zeroizing<[u8; 32]>, usize)> {
        self.seal().await?;
        self.file.flush().await?;
        Ok((self.key, self.bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;
    use std::process::Stdio;
    #[tokio::test]
    async fn rust_spools_decode_in_the_node_helper_without_a_plaintext_file() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        std::fs::create_dir_all(root.join("tmp")).unwrap();
        let directory = tempfile::Builder::new()
            .prefix("native-encryption-test-")
            .tempdir_in(root.join("tmp"))
            .unwrap();
        let path = directory.path().join("audio.enc");
        let mut writer = Writer::create(&path).await.unwrap();
        let samples = vec![0.25f32; 20_000];
        let bytes: Vec<_> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        for part in bytes.chunks(3) {
            writer.append(part).await.unwrap();
        }
        let (key, length) = writer.finish().await.unwrap();
        let disk = std::fs::read(&path).unwrap();
        assert_eq!(&disk[..8], b"ECHOPCM1");
        assert_eq!(disk.len(), bytes.len() + 8 + 2 * 20);
        assert!(!disk.windows(32).any(|part| part == &bytes[..32]));
        let mut child = tokio::process::Command::new("node").args(["--input-type=module", "-e", "import {readEncryptedPCM} from './scripts/native-speech.mjs';let s='';for await(const b of process.stdin)s+=b;const a=await readEncryptedPCM(JSON.parse(s));if(a.length!==20000||a.some(x=>x!==0.25))process.exit(2);"])
            .current_dir(root).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap();
        let payload = Zeroizing::new(serde_json::to_vec(&json!({"operation":"transcribe","cacheDir":directory.path(),"audioPath":path,"audioBytes":length,"audioKey":STANDARD.encode(key.as_ref())})).unwrap());
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&payload)
            .await
            .unwrap();
        let result = child.wait_with_output().await.unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }
}
