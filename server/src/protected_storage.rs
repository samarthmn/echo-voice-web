//! Authenticated local files and OS-held library keys. No plaintext fallback.
//! The file header and every 64 KiB block are independently authenticated so
//! audio range requests need not decrypt an entire recording into memory.
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
use zeroize::Zeroizing;

const MAGIC: &[u8; 8] = b"ECHOENC1";
const HEADER_BYTES: usize = 64;
const BLOCK: usize = 65_536;
const MAX_FILE: u64 = 512 * 1024 * 1024;
type Result<T> = std::io::Result<T>;
fn invalid() -> std::io::Error {
    std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        "Encrypted data failed authentication. Saved files have not been changed.",
    )
}
fn key_error() -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::PermissionDenied,"Echo cannot unlock this library. Unlock the operating system credential store and retry. No new key or plaintext library was created.")
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}
pub(crate) struct LibraryKey(Zeroizing<[u8; 32]>);
impl LibraryKey {
    pub(crate) fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }
    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub(crate) fn sqlcipher_key(&self) -> Zeroizing<String> {
        Zeroizing::new(format!(
            "x'{}'",
            self.0
                .iter()
                .map(|value| format!("{value:02x}"))
                .collect::<String>()
        ))
    }
    fn cipher(&self, salt: &[u8], context: &str) -> Result<Aes256Gcm> {
        if context.is_empty() || context.len() > 1024 {
            return Err(invalid());
        }
        let mut key = Zeroizing::new([0u8; 32]);
        Hkdf::<Sha256>::new(Some(salt), self.0.as_ref())
            .expand(format!("echo-file-v1:{context}").as_bytes(), key.as_mut())
            .map_err(|_| invalid())?;
        Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| invalid())
    }
}
pub(crate) fn is_encrypted(path: &Path) -> Result<bool> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid());
    }
    let mut prefix = [0; 8];
    let mut file = File::open(path)?;
    Ok(file.read(&mut prefix)? == prefix.len() && &prefix == MAGIC)
}
#[derive(Serialize, Deserialize)]
struct KeyReference {
    version: u8,
    key_id: String,
}

/// Run before creating an OS key entry. Missing descriptors cannot authorize a
/// replacement key while any encrypted library data remains, including optional
/// ChatGPT state after partial loss of the database and key reference.
#[cfg(target_os = "macos")]
fn preflight_new_library_key(root: &Path) -> Result<()> {
    let database = root.join("workspace.sqlite");
    if database.exists() {
        let mut prefix = [0; 16];
        let mut file = File::open(database)?;
        if file.read(&mut prefix)? != 16 || &prefix != b"SQLite format 3\0" {
            return Err(key_error());
        }
    }
    if root.join("recovery.json").exists() || root.join(".workspace-encrypted.sqlite").exists() {
        return Err(key_error());
    }
    for area in ["audio", "extension-pcm", "credentials", "chatgpt"] {
        if contains_encrypted_file(&root.join(area), area == "chatgpt", area == "credentials")? {
            return Err(key_error());
        }
    }
    Ok(())
}

/// The descriptor contains only a random keychain entry identifier. Missing,
/// locked or corrupt existing keys never trigger replacement or plaintext use.
pub(crate) fn library_key(root: &Path) -> Result<LibraryKey> {
    let reference = root.join("protection.json");
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var("ECHO_TEST_STORAGE_KEY") {
        if std::env::var("ECHO_TEST_MODE").as_deref() != Ok("1")
            || std::env::var_os("ECHO_DATA_DIR").is_none()
        {
            return Err(key_error());
        }
        let decoded = STANDARD.decode(raw).map_err(|_| key_error())?;
        let bytes: [u8; 32] = decoded.try_into().map_err(|_| key_error())?;
        return Ok(LibraryKey::from_bytes(bytes));
    }
    #[cfg(not(debug_assertions))]
    if std::env::var_os("ECHO_TEST_STORAGE_KEY").is_some() {
        return Err(key_error());
    }
    #[cfg(target_os = "macos")]
    {
        if fs::symlink_metadata(&reference).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("Symbolic link in key descriptor: {}", reference.display()),
            ));
        }
        let existing = match fs::read(&reference) {
            Ok(bytes) => Some(serde_json::from_slice::<KeyReference>(&bytes).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Invalid key descriptor: {e}"),
                )
            })?),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if let Some(existing) = existing {
            if existing.version != 1 || uuid::Uuid::parse_str(&existing.key_id).is_err() {
                return Err(key_error());
            }
            let entry = keyring::Entry::new("com.echo.voice.library", &existing.key_id)
                .map_err(|e| std::io::Error::other(format!("Keychain entry: {e}")))?;
            let password = Zeroizing::new(
                entry
                    .get_password()
                    .map_err(|e| std::io::Error::other(format!("Keychain read: {e}")))?,
            );
            let decoded = Zeroizing::new(
                STANDARD
                    .decode(password.as_bytes())
                    .map_err(|_| key_error())?,
            );
            let bytes: [u8; 32] = decoded.as_slice().try_into().map_err(|_| key_error())?;
            return Ok(LibraryKey::from_bytes(bytes));
        }
        // Existing encrypted data with a missing descriptor must not acquire a
        // new unrelated key. New or plaintext libraries may be migrated later.
        preflight_new_library_key(root)?;
        let key_id = uuid::Uuid::new_v4().to_string();
        let entry = keyring::Entry::new("com.echo.voice.library", &key_id)
            .map_err(|e| std::io::Error::other(format!("Keychain entry: {e}")))?;
        let mut bytes = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(bytes.as_mut());
        let encoded = Zeroizing::new(STANDARD.encode(bytes.as_ref()));
        entry
            .set_password(&encoded)
            .map_err(|e| std::io::Error::other(format!("Keychain write: {e}")))?;
        let confirmed = Zeroizing::new(
            entry
                .get_password()
                .map_err(|e| std::io::Error::other(format!("Keychain read: {e}")))?,
        );
        if confirmed.as_str() != encoded.as_str() {
            return Err(key_error());
        }
        let payload =
            serde_json::to_vec(&KeyReference { version: 1, key_id }).map_err(|_| invalid())?;
        let temporary = root.join(format!(".protection-{}.tmp", uuid::Uuid::new_v4()));
        let saved = (|| {
            let mut file = private_options().open(&temporary)?;
            file.write_all(&payload)?;
            file.sync_all()?;
            fs::rename(&temporary, &reference)?;
            File::open(root)?.sync_all()
        })();
        if saved.is_err() {
            let _ = fs::remove_file(&temporary);
            // Once the descriptor has been published the key must survive a
            // failed directory sync; deleting it would strand that library.
            if !reference.exists() {
                let _ = entry.delete_credential();
            }
        }
        saved?;
        Ok(LibraryKey::from_bytes(*bytes))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = reference;
        Err(key_error())
    }
}
/// Explicit recovery only. The caller must hold workspace.lock and verify both
/// the recovery phrase envelope and the encrypted database with this master
/// before calling. Normal library loading never invokes this repair path.
pub(crate) fn restore_library_key(root: &Path, master: &[u8; 32]) -> Result<()> {
    #[cfg(debug_assertions)]
    if let Ok(raw) = std::env::var("ECHO_TEST_STORAGE_KEY") {
        if std::env::var("ECHO_TEST_MODE").as_deref() != Ok("1")
            || std::env::var_os("ECHO_DATA_DIR").is_none()
        {
            return Err(key_error());
        }
        let decoded = Zeroizing::new(STANDARD.decode(raw).map_err(|_| key_error())?);
        return if decoded.as_slice() == master {
            Ok(())
        } else {
            Err(key_error())
        };
    }
    #[cfg(not(debug_assertions))]
    if std::env::var_os("ECHO_TEST_STORAGE_KEY").is_some() {
        return Err(key_error());
    }
    #[cfg(target_os = "macos")]
    {
        let path = root.join("protection.json");
        if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(key_error());
        }
        let existing = match fs::read(&path) {
            Ok(bytes) => Some(serde_json::from_slice::<KeyReference>(&bytes).map_err(|e| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Invalid key descriptor: {e}"),
                )
            })?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
        let publish = existing.is_none();
        let reference = existing.unwrap_or_else(|| KeyReference {
            version: 1,
            key_id: uuid::Uuid::new_v4().to_string(),
        });
        if reference.version != 1 || uuid::Uuid::parse_str(&reference.key_id).is_err() {
            return Err(key_error());
        }
        let entry = keyring::Entry::new("com.echo.voice.library", &reference.key_id)
            .map_err(|_| key_error())?;
        let encoded = Zeroizing::new(STANDARD.encode(master));
        entry
            .set_password(&encoded)
            .map_err(|e| std::io::Error::other(format!("Keychain write: {e}")))?;
        let confirmed = Zeroizing::new(
            entry
                .get_password()
                .map_err(|e| std::io::Error::other(format!("Keychain read: {e}")))?,
        );
        if confirmed.as_str() != encoded.as_str() {
            return Err(key_error());
        }
        if publish {
            let staged = root.join(format!(".protection-{}.tmp", uuid::Uuid::new_v4()));
            let outcome = (|| {
                let payload = serde_json::to_vec(&reference).map_err(|_| invalid())?;
                let mut file = private_options().open(&staged)?;
                file.write_all(&payload)?;
                file.sync_all()?;
                fs::rename(&staged, &path)?;
                File::open(root)?.sync_all()
            })();
            if outcome.is_err() {
                let _ = fs::remove_file(&staged);
                if !path.exists() {
                    let _ = entry.delete_credential();
                }
            }
            outcome?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (root, master);
        Err(key_error())
    }
}
#[cfg(target_os = "macos")]
fn contains_encrypted_file(
    directory: &Path,
    chatgpt_root: bool,
    credentials_root: bool,
) -> Result<bool> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("Symbolic link in protected data: {}", directory.display()),
        ));
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if chatgpt_root && entry.file_name() == "tmp" {
            continue;
        }
        if entry.file_type()?.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "Symbolic link in protected data: {}",
                    entry.path().display()
                ),
            ));
        }
        if credentials_root
            && matches!(
                entry.file_name().to_str(),
                Some("runner-token" | "runner-token.lock")
            )
            && entry.file_type()?.is_file()
        {
            continue;
        }
        if entry.file_type()?.is_dir() {
            if contains_encrypted_file(&entry.path(), false, false)? {
                return Ok(true);
            }
        } else if entry.file_type()?.is_file() && is_encrypted(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}
fn nonce(index: u64) -> [u8; 12] {
    let mut nonce = [0; 12];
    nonce[4..].copy_from_slice(&index.to_be_bytes());
    nonce
}
fn binding(header: &[u8], index: u64) -> Vec<u8> {
    let mut value = header.to_vec();
    value.extend_from_slice(&index.to_be_bytes());
    value
}
pub(crate) fn write_file(
    key: &LibraryKey,
    path: &Path,
    context: &str,
    plaintext: &[u8],
) -> Result<()> {
    if plaintext.len() as u64 > MAX_FILE {
        return Err(invalid());
    }
    let mut header = [0u8; 48];
    header[..8].copy_from_slice(MAGIC);
    OsRng.fill_bytes(&mut header[8..40]);
    header[40..].copy_from_slice(&(plaintext.len() as u64).to_le_bytes());
    let cipher = key.cipher(&header[8..40], context)?;
    let tag = cipher
        .encrypt(
            Nonce::from_slice(&nonce(0)),
            Payload {
                msg: &[],
                aad: &header,
            },
        )
        .map_err(|_| invalid())?;
    let mut file = private_options().open(path)?;
    file.write_all(&header)?;
    file.write_all(&tag)?;
    for (index, block) in plaintext.chunks(BLOCK).enumerate() {
        let sequence = index as u64 + 1;
        let sealed = cipher
            .encrypt(
                Nonce::from_slice(&nonce(sequence)),
                Payload {
                    msg: block,
                    aad: &binding(&header, sequence),
                },
            )
            .map_err(|_| invalid())?;
        file.write_all(&sealed)?;
    }
    file.sync_all()
}
pub(crate) struct Reader {
    file: File,
    cipher: Aes256Gcm,
    header: [u8; 48],
    len: u64,
}
impl Reader {
    pub(crate) fn open(key: &LibraryKey, path: &Path, context: &str) -> Result<Self> {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(invalid());
        }
        let mut file = File::open(path)?;
        let mut header = [0; 48];
        file.read_exact(&mut header)?;
        if &header[..8] != MAGIC {
            return Err(invalid());
        }
        let len = u64::from_le_bytes(header[40..48].try_into().map_err(|_| invalid())?);
        if len > MAX_FILE
            || file.metadata()?.len() != HEADER_BYTES as u64 + len + len.div_ceil(BLOCK as u64) * 16
        {
            return Err(invalid());
        }
        let cipher = key.cipher(&header[8..40], context)?;
        let mut tag = [0; 16];
        file.read_exact(&mut tag)?;
        cipher
            .decrypt(
                Nonce::from_slice(&nonce(0)),
                Payload {
                    msg: &tag,
                    aad: &header,
                },
            )
            .map_err(|_| invalid())?;
        Ok(Self {
            file,
            cipher,
            header,
            len,
        })
    }
    pub(crate) fn len(&self) -> u64 {
        self.len
    }
    pub(crate) fn read_range(&mut self, start: u64, length: usize) -> Result<Vec<u8>> {
        let end = start.checked_add(length as u64).ok_or_else(invalid)?;
        if end > self.len || length > 8 * 1024 * 1024 {
            return Err(invalid());
        }
        let mut output = Vec::with_capacity(length);
        let mut offset = start;
        while offset < end {
            let index = offset / BLOCK as u64;
            let block_start = index * BLOCK as u64;
            let block_length = (self.len - block_start).min(BLOCK as u64) as usize;
            self.file.seek(SeekFrom::Start(
                HEADER_BYTES as u64 + index * (BLOCK as u64 + 16),
            ))?;
            let mut sealed = vec![0; block_length + 16];
            self.file.read_exact(&mut sealed)?;
            let plaintext = Zeroizing::new(
                self.cipher
                    .decrypt(
                        Nonce::from_slice(&nonce(index + 1)),
                        Payload {
                            msg: &sealed,
                            aad: &binding(&self.header, index + 1),
                        },
                    )
                    .map_err(|_| invalid())?,
            );
            let from = (offset - block_start) as usize;
            let count = (end - offset).min((block_length - from) as u64) as usize;
            output.extend_from_slice(&plaintext[from..from + count]);
            offset += count as u64;
        }
        Ok(output)
    }
    pub(crate) fn read_all(&mut self) -> Result<Vec<u8>> {
        let mut output = Vec::with_capacity(self.len as usize);
        while output.len() < (self.len as usize) {
            let start = output.len() as u64;
            output
                .extend(self.read_range(start, (self.len - start).min(8 * 1024 * 1024) as usize)?);
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_test_recovery_never_writes_an_os_key_or_descriptor() {
        let _guard = crate::store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = crate::store::test_directory();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        crate::store::test_key();
        restore_library_key(directory.path(), &[42; 32]).unwrap();
        assert!(restore_library_key(directory.path(), &[43; 32]).is_err());
        assert!(!directory.path().join("protection.json").exists());
        std::env::remove_var("ECHO_TEST_MODE");
        assert!(restore_library_key(directory.path(), &[42; 32]).is_err());
        crate::store::test_key();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    fn fixture() -> tempfile::TempDir {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tmp");
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix("protected-storage-")
            .tempdir_in(root)
            .unwrap()
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn missing_key_reference_rejects_chatgpt_remnants_before_key_or_database_creation() {
        for relative in ["chatgpt/auth.json", "chatgpt/sessions/history.jsonl"] {
            let dir = fixture();
            let root = dir.path();
            // This is the exact guard invoked before Entry::new/set_password.
            // Calling it directly never reaches an OS credential provider.
            preflight_new_library_key(root).unwrap();
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let key = LibraryKey::from_bytes([31; 32]);
            write_file(&key, &path, "synthetic-chatgpt-state", b"synthetic state").unwrap();
            let before = fs::read(&path).unwrap();
            let error = preflight_new_library_key(root).unwrap_err();
            assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
            assert_eq!(fs::read(&path).unwrap(), before);
            assert!(!root.join("protection.json").exists());
            assert!(!root.join("workspace.sqlite").exists());
            // A remaining plaintext database must not bypass the same guard.
            let database = root.join("workspace.sqlite");
            fs::write(&database, b"SQLite format 3\0synthetic legacy database").unwrap();
            let database_before = fs::read(&database).unwrap();
            assert!(preflight_new_library_key(root).is_err());
            assert_eq!(fs::read(&database).unwrap(), database_before);
            assert_eq!(fs::read(&path).unwrap(), before);
            assert!(!root.join("protection.json").exists());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn preflight_allows_only_unprotected_chatgpt_state_for_legacy_migration() {
        let dir = fixture();
        let path = dir.path().join("chatgpt/auth.json");
        fs::create_dir(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{\"fixture\":true}").unwrap();
        preflight_new_library_key(dir.path()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"{\"fixture\":true}");
        assert!(!dir.path().join("protection.json").exists());
        assert!(!dir.path().join("workspace.sqlite").exists());
    }
    #[test]
    #[cfg(unix)]
    fn codex_transient_symlinks_do_not_block_preflight() {
        use std::os::unix::fs::symlink;
        let dir = fixture();
        let transient = dir.path().join("chatgpt/tmp/arg0/codex-arg123");
        fs::create_dir_all(&transient).unwrap();
        symlink("/missing/codex", transient.join("apply_patch")).unwrap();
        preflight_new_library_key(dir.path()).unwrap();
        symlink("/missing/secret", dir.path().join("chatgpt/auth.json")).unwrap();
        assert!(preflight_new_library_key(dir.path()).is_err());
    }
    #[test]
    fn ranges_and_empty_files_are_authenticated() {
        let dir = fixture();
        let key = LibraryKey::from_bytes([7; 32]);
        let data: Vec<_> = (0..BLOCK * 3 + 12).map(|i| (i % 251) as u8).collect();
        let path = dir.path().join("audio");
        write_file(&key, &path, "audio:recording-1:part-1", &data).unwrap();
        let mut reader = Reader::open(&key, &path, "audio:recording-1:part-1").unwrap();
        assert_eq!(reader.len(), data.len() as u64);
        for (start, len) in [
            (0, 0),
            (0, 1),
            (BLOCK - 2, 8),
            (BLOCK + 12, BLOCK * 2),
            (data.len() - 1, 1),
        ] {
            assert_eq!(
                reader.read_range(start as u64, len).unwrap(),
                data[start..start + len]
            );
        }
        assert_eq!(reader.read_all().unwrap(), data);
        assert!(reader.read_range(data.len() as u64, 1).is_err());
        let empty = dir.path().join("empty");
        write_file(&key, &empty, "empty", &[]).unwrap();
        assert_eq!(
            Reader::open(&key, &empty, "empty")
                .unwrap()
                .read_all()
                .unwrap(),
            Vec::<u8>::new()
        );
        assert!(Reader::open(&key, &empty, "wrong-context").is_err());
    }
    #[test]
    fn tampering_swapping_and_truncation_fail_without_altering_the_file() {
        let dir = fixture();
        let key = LibraryKey::from_bytes([8; 32]);
        let path = dir.path().join("audio");
        write_file(&key, &path, "audio:1", &vec![42; BLOCK + 10]).unwrap();
        let original = fs::read(&path).unwrap();
        assert!(Reader::open(&LibraryKey::from_bytes([9; 32]), &path, "audio:1").is_err());
        assert!(Reader::open(&key, &path, "audio:2").is_err());
        for index in [0, 12, 42, 55, 70, HEADER_BYTES + BLOCK + 16 + 1] {
            let mut changed = original.clone();
            changed[index] ^= 1;
            fs::write(&path, &changed).unwrap();
            assert!(Reader::open(&key, &path, "audio:1")
                .and_then(|mut r| r.read_all())
                .is_err());
            assert_eq!(fs::read(&path).unwrap(), changed);
        }
        fs::write(&path, &original[..original.len() - 1]).unwrap();
        assert!(Reader::open(&key, &path, "audio:1").is_err());
    }
    #[test]
    fn repeated_writes_use_independent_file_keys_and_never_overwrite() {
        let dir = fixture();
        let key = LibraryKey::from_bytes([1; 32]);
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        write_file(&key, &first, "same", b"same audio").unwrap();
        write_file(&key, &second, "same", b"same audio").unwrap();
        assert_ne!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
        assert!(write_file(&key, &first, "same", b"replacement").is_err());
        assert_eq!(
            Reader::open(&key, &first, "same")
                .unwrap()
                .read_all()
                .unwrap(),
            b"same audio"
        );
    }
}
