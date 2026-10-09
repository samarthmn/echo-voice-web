//! Local recovery phrases and portable encrypted backups. Phrases are returned
//! once during setup, never written to disk, included in URLs, or logged.
use crate::{protected_storage::LibraryKey, security::ApiError, store};
use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use bip39::{Language, Mnemonic};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use uuid::Uuid;
use zeroize::Zeroizing;

type Result<T> = std::result::Result<T, ApiError>;
const MAX_BACKUP: usize = 180 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Sealed {
    nonce: String,
    ciphertext: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Recovery {
    version: u8,
    id: String,
    fingerprint: String,
    sealed: Sealed,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    integrity: Option<Sealed>,
}
struct Pending {
    id: String,
    expires: Instant,
    recovery: Recovery,
    words: Vec<Zeroizing<String>>,
}
static PENDING: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
fn failure() -> ApiError {
    ApiError::bad("The recovery phrase or encrypted backup is invalid. Your saved library has not been changed.")
}
fn fingerprint(key: &[u8; 32]) -> String {
    STANDARD.encode(Sha256::digest(
        [b"echo-library-key-v1:".as_slice(), key].concat(),
    ))
}
fn key_for(secret: &[u8], salt: &str, purpose: &str) -> Result<Aes256Gcm> {
    let mut key = Zeroizing::new([0u8; 32]);
    Hkdf::<Sha256>::new(Some(salt.as_bytes()), secret)
        .expand(purpose.as_bytes(), key.as_mut())
        .map_err(|_| failure())?;
    Aes256Gcm::new_from_slice(key.as_ref()).map_err(|_| failure())
}
fn seal(cipher: &Aes256Gcm, data: &[u8], context: &[u8]) -> Result<Sealed> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: data,
                aad: context,
            },
        )
        .map_err(|_| failure())?;
    Ok(Sealed {
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}
fn open(
    cipher: &Aes256Gcm,
    sealed: &Sealed,
    context: &[u8],
    max: usize,
) -> Result<Zeroizing<Vec<u8>>> {
    if sealed.nonce.len() != 16 || sealed.ciphertext.len() > ((max + 16).div_ceil(3) * 4) {
        return Err(failure());
    }
    let nonce = STANDARD.decode(&sealed.nonce).map_err(|_| failure())?;
    if nonce.len() != 12 {
        return Err(failure());
    }
    let ciphertext = STANDARD.decode(&sealed.ciphertext).map_err(|_| failure())?;
    if ciphertext.len() > max + 16 {
        return Err(failure());
    }
    Ok(Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: context,
                },
            )
            .map_err(|_| failure())?,
    ))
}
fn recovery_context(id: &str, fingerprint: &str) -> Vec<u8> {
    serde_json::to_vec(&json!(["echo-library-recovery", 1, id, fingerprint])).unwrap()
}
fn integrity_context(recovery: &Recovery) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&json!([
        "echo-library-recovery-integrity",
        recovery.version,
        recovery.id,
        recovery.fingerprint,
        recovery.sealed.nonce,
        recovery.sealed.ciphertext
    ]))?)
}
fn validate_recovery_structure(recovery: &Recovery) -> Result<()> {
    if recovery.version != 1
        || Uuid::parse_str(&recovery.id).is_err()
        || recovery.fingerprint.len() != 44
        || STANDARD
            .decode(&recovery.fingerprint)
            .map_err(|_| failure())?
            .len()
            != 32
        || recovery.sealed.nonce.len() != 16
        || STANDARD
            .decode(&recovery.sealed.nonce)
            .map_err(|_| failure())?
            .len()
            != 12
        || recovery.sealed.ciphertext.len() != 64
        || STANDARD
            .decode(&recovery.sealed.ciphertext)
            .map_err(|_| failure())?
            .len()
            != 48
    {
        return Err(failure());
    }
    Ok(())
}
/// A separate master-key tag binds the phrase envelope itself. The unlocked
/// library can detect damaged recovery ciphertext without knowing the phrase.
fn validate_recovery(recovery: &Recovery, master: &[u8; 32]) -> Result<()> {
    validate_recovery_structure(recovery)?;
    if recovery.fingerprint != fingerprint(master) {
        return Err(failure());
    }
    let integrity = recovery.integrity.as_ref().ok_or_else(failure)?;
    let cipher = key_for(master, &recovery.id, "Echo recovery metadata integrity v1")?;
    if !open(&cipher, integrity, &integrity_context(recovery)?, 0)?.is_empty() {
        return Err(failure());
    }
    Ok(())
}
fn make_recovery(master: &[u8; 32]) -> Result<(Recovery, Zeroizing<String>)> {
    let mut entropy = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(entropy.as_mut());
    let phrase = Zeroizing::new(
        Mnemonic::from_entropy(entropy.as_ref())
            .map_err(|_| failure())?
            .to_string(),
    );
    let id = Uuid::new_v4().to_string();
    let fingerprint = fingerprint(master);
    let cipher = key_for(entropy.as_ref(), &id, "Echo library recovery v1")?;
    let sealed = seal(&cipher, master, &recovery_context(&id, &fingerprint))?;
    let mut recovery = Recovery {
        version: 1,
        id,
        fingerprint,
        sealed,
        integrity: None,
    };
    let cipher = key_for(master, &recovery.id, "Echo recovery metadata integrity v1")?;
    recovery.integrity = Some(seal(&cipher, &[], &integrity_context(&recovery)?)?);
    Ok((recovery, phrase))
}
fn recover_key(recovery: &Recovery, phrase: &str) -> Result<Zeroizing<[u8; 32]>> {
    validate_recovery_structure(recovery)?;
    if phrase.len() > 1024 {
        return Err(failure());
    }
    let normalized = Zeroizing::new(
        phrase
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>()
            .join(" "),
    );
    let mnemonic =
        Mnemonic::parse_in(Language::English, normalized.as_str()).map_err(|_| failure())?;
    if mnemonic.word_count() != 24 {
        return Err(failure());
    }
    let entropy = Zeroizing::new(mnemonic.to_entropy());
    let cipher = key_for(&entropy, &recovery.id, "Echo library recovery v1")?;
    let bytes = open(
        &cipher,
        &recovery.sealed,
        &recovery_context(&recovery.id, &recovery.fingerprint),
        32,
    )?;
    let key: [u8; 32] = bytes.as_slice().try_into().map_err(|_| failure())?;
    if fingerprint(&key) != recovery.fingerprint {
        return Err(failure());
    }
    // Draft envelopes remain recoverable with their original phrase, but they
    // cannot pass copy validation until recovery setup creates an integrity tag.
    if recovery.integrity.is_some() {
        validate_recovery(recovery, &key)?;
    }
    Ok(Zeroizing::new(key))
}
fn read_recovery(root: &Path) -> Result<Option<Recovery>> {
    let path = root.join("recovery.json");
    match fs::symlink_metadata(&path) {
        Ok(metadata)
            if metadata.is_file()
                && !metadata.file_type().is_symlink()
                && metadata.len() <= 4096 => {}
        Ok(_) => return Err(failure()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 {
        return Err(failure());
    }
    Ok(Some(serde_json::from_slice(&bytes).map_err(|_| failure())?))
}
pub(crate) fn validate_saved_recovery() -> Result<()> {
    let invalid = || {
        ApiError::bad("The selected library's recovery metadata is damaged or from an unsupported draft format. Save and confirm a new recovery phrase in the original library before copying it. Saved files have not been changed.")
    };
    let Some(recovery) = read_recovery(&store::data_dir()).map_err(|_| invalid())? else {
        return Ok(());
    };
    store::with_key(|key| validate_recovery(&recovery, key.bytes()).map_err(std::io::Error::other))
        .map_err(|_| invalid())
}
fn write_recovery(root: &Path, value: &Recovery) -> Result<()> {
    use std::io::Write;
    let path = root.join(format!(".recovery-{}.tmp", Uuid::new_v4()));
    let result = (|| -> Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(&serde_json::to_vec(value)?)?;
        file.sync_all()?;
        fs::rename(&path, root.join("recovery.json"))?;
        fs::File::open(root)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(path);
    }
    result
}
pub(crate) fn routes() -> Router {
    Router::new()
        .route("/privacy/status", get(status))
        .route("/privacy/recovery/prepare", post(prepare))
        .route("/privacy/recovery/confirm", post(confirm))
        .route("/privacy/recovery/cancel", post(cancel))
        .layer(DefaultBodyLimit::max(4096))
}
/// Used by the explicit recovery command before the HTTP server opens.
/// Validate the phrase and database read-only, then repair OS unlock material.
pub(crate) fn recover_library(root: &Path, phrase: &str) -> Result<()> {
    use fs2::FileExt;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("workspace.lock"))?;
    store::secure(&root.join("workspace.lock"), false)?;
    lock.try_lock_exclusive().map_err(|_| {
        ApiError::new(
            409,
            "Quit every Echo window using this library before recovering its key.",
        )
    })?;
    let recovery = read_recovery(root)?.ok_or_else(|| {
        ApiError::bad(
            "This library has no saved recovery phrase. Restore an encrypted backup instead.",
        )
    })?;
    let master = recover_key(&recovery, phrase)?;
    let db = rusqlite::Connection::open_with_flags(
        root.join("workspace.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|_| failure())?;
    let key = LibraryKey::from_bytes(*master);
    db.pragma_update(None, "key", key.sqlcipher_key().as_str())
        .map_err(|_| failure())?;
    db.query_row("SELECT count(*) FROM sqlite_master", [], |row| {
        row.get::<_, i64>(0)
    })
    .map_err(|_| failure())?;
    let integrity: String = db
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|_| failure())?;
    if integrity != "ok" {
        return Err(failure());
    }
    drop(db);
    crate::protected_storage::restore_library_key(root, &master)?;
    Ok(())
}
async fn status() -> Result<Json<Value>> {
    let recovery = read_recovery(&store::data_dir())?;
    let recovery_ready = if let Some(recovery) = recovery {
        store::with_key(|key| Ok(validate_recovery(&recovery, key.bytes()).is_ok()))?
    } else {
        false
    };
    Ok(Json(
        json!({"protected":true,"recoveryReady":recovery_ready,"phraseWords":24}),
    ))
}
async fn prepare() -> Result<Json<Value>> {
    let (recovery, phrase) =
        store::with_key(|key| make_recovery(key.bytes()).map_err(std::io::Error::other))?;
    let words = phrase.split_whitespace().collect::<Vec<_>>();
    let indices = [3usize, 11, 20];
    let id = Uuid::new_v4().to_string();
    let mut pending = PENDING
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| failure())?;
    *pending = Some(Pending {
        id: id.clone(),
        expires: Instant::now() + Duration::from_secs(600),
        recovery,
        words: indices
            .iter()
            .map(|index| Zeroizing::new(words[index - 1].to_string()))
            .collect(),
    });
    Ok(Json(
        json!({"setupId":id,"phrase":phrase.as_str(),"confirmWords":indices,"expiresInSeconds":600}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    #[serde(rename = "setupId")]
    id: String,
    words: Vec<String>,
}
async fn confirm(Json(input): Json<Confirmation>) -> Result<Json<Value>> {
    if input.words.len() != 3 || input.words.iter().any(|word| word.len() > 32) {
        return Err(failure());
    }
    let mut guard = PENDING
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| failure())?;
    let pending = guard.as_ref().ok_or_else(|| {
        ApiError::bad("Recovery setup expired. Generate a new phrase and save it.")
    })?;
    if pending.id != input.id || pending.expires < Instant::now() {
        return Err(ApiError::bad(
            "Recovery setup expired. Generate a new phrase and save it.",
        ));
    }
    if input
        .words
        .iter()
        .zip(&pending.words)
        .any(|(actual, expected)| actual.trim().to_lowercase() != expected.as_str())
    {
        return Err(ApiError::bad(
            "Those words do not match. Check the phrase you saved and try again.",
        ));
    }
    write_recovery(&store::data_dir(), &pending.recovery)?;
    *guard = None;
    Ok(Json(json!({"recoveryReady":true})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cancellation {
    #[serde(rename = "setupId")]
    id: String,
}
async fn cancel(Json(input): Json<Cancellation>) -> Result<Json<Value>> {
    let mut guard = PENDING
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| failure())?;
    if guard.as_ref().is_some_and(|value| value.id == input.id) {
        *guard = None;
    }
    Ok(Json(json!({"ok":true})))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Backup {
    format: String,
    version: u8,
    id: String,
    recovery: Recovery,
    data: Sealed,
}
fn backup_context(id: &str, recovery: &Recovery) -> Result<Vec<u8>> {
    Ok(serde_json::to_vec(&json!([
        "echo-voice-encrypted",
        1,
        id,
        recovery
    ]))?)
}
pub(crate) fn encrypt_backup(plaintext: Value) -> Result<Value> {
    let recovery=read_recovery(&store::data_dir())?.ok_or_else(||ApiError::new(409,"Save and confirm your library recovery phrase in Settings → Storage before creating an encrypted backup."))?;
    let bytes = Zeroizing::new(serde_json::to_vec(&plaintext)?);
    if bytes.len() > MAX_BACKUP {
        return Err(ApiError::new(
            413,
            "This library is too large for a single backup.",
        ));
    }
    store::with_key(|key| seal_backup(key, &recovery, &bytes).map_err(std::io::Error::other))
        .map_err(ApiError::from)
}
fn seal_backup(key: &LibraryKey, recovery: &Recovery, bytes: &[u8]) -> Result<Value> {
    validate_recovery(recovery, key.bytes())?;
    let id = Uuid::new_v4().to_string();
    let cipher = key_for(key.bytes(), &id, "Echo encrypted backup v1")?;
    let data = seal(&cipher, bytes, &backup_context(&id, recovery)?)?;
    Ok(serde_json::to_value(Backup {
        format: "echo-voice-encrypted".into(),
        version: 1,
        id,
        recovery: recovery.clone(),
        data,
    })?)
}
pub(crate) fn decrypt_backup(value: Value, phrase: Option<&str>) -> Result<Value> {
    let backup: Backup = serde_json::from_value(value).map_err(|_| failure())?;
    if backup.format != "echo-voice-encrypted"
        || backup.version != 1
        || Uuid::parse_str(&backup.id).is_err()
    {
        return Err(failure());
    }
    let key = if let Some(phrase) = phrase {
        recover_key(&backup.recovery, phrase)?
    } else {
        store::with_key(|key| {
            Ok((fingerprint(key.bytes()) == backup.recovery.fingerprint)
                .then(|| Zeroizing::new(*key.bytes())))
        })?
        .ok_or_else(|| {
            ApiError::new(
                409,
                "Enter the recovery phrase saved when this backup was created.",
            )
        })?
    };
    decode_backup(&backup, &key)
}
fn decode_backup(backup: &Backup, key: &[u8; 32]) -> Result<Value> {
    let cipher = key_for(key, &backup.id, "Echo encrypted backup v1")?;
    let plaintext = open(
        &cipher,
        &backup.data,
        &backup_context(&backup.id, &backup.recovery)?,
        MAX_BACKUP,
    )?;
    serde_json::from_slice(&plaintext).map_err(|_| failure())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copied_recovery_metadata_authenticates_envelope_without_phrase_and_preserves_damage() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        let (recovery, phrase) = make_recovery(&[42; 32]).unwrap();
        let path = directory.path().join("recovery.json");
        crate::library_validation::verify().unwrap();
        write_recovery(directory.path(), &recovery).unwrap();
        crate::library_validation::verify().unwrap();
        let original = serde_json::to_value(&recovery).unwrap();
        let mut variants = Vec::new();
        for pointer in [
            "/version",
            "/id",
            "/fingerprint",
            "/sealed/nonce",
            "/sealed/ciphertext",
            "/integrity/nonce",
            "/integrity/ciphertext",
        ] {
            let mut value = original.clone();
            let replacement = match pointer {
                "/version" => json!(2),
                "/id" => json!(Uuid::new_v4().to_string()),
                "/fingerprint" => json!(fingerprint(&[43; 32])),
                _ => {
                    let mut bytes = STANDARD
                        .decode(value.pointer(pointer).unwrap().as_str().unwrap())
                        .unwrap();
                    bytes[0] ^= 1;
                    json!(STANDARD.encode(bytes))
                }
            };
            *value.pointer_mut(pointer).unwrap() = replacement;
            variants.push(serde_json::to_vec(&value).unwrap());
        }
        let mut draft = recovery.clone();
        draft.integrity = None;
        // The phrase can still recover an old draft; selection cannot claim
        // integrity without a tag made by the current unlocked library.
        assert_eq!(recover_key(&draft, &phrase).unwrap().as_ref(), &[42; 32]);
        variants.push(serde_json::to_vec(&draft).unwrap());
        variants.push(vec![b' '; 4097]);
        for bytes in variants {
            fs::write(&path, &bytes).unwrap();
            let error = crate::library_validation::verify().unwrap_err().to_string();
            assert!(error.contains("Save and confirm a new recovery phrase"));
            assert!(!error.contains(phrase.as_str()));
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        write_recovery(directory.path(), &recovery).unwrap();
        crate::library_validation::verify().unwrap();
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    #[test]
    fn recovery_and_portable_backup_require_the_original_phrase() {
        let master = LibraryKey::from_bytes([19; 32]);
        let (recovery, phrase) = make_recovery(master.bytes()).unwrap();
        assert_eq!(phrase.split_whitespace().count(), 24);
        let restored = recover_key(&recovery, &phrase).unwrap();
        assert_eq!(restored.as_ref(), master.bytes());
        let value = json!({"format":"echo-voice-web","meetings":[{"title":"private title","transcript":"private words"}]});
        let wrapped =
            seal_backup(&master, &recovery, &serde_json::to_vec(&value).unwrap()).unwrap();
        let serialized = wrapped.to_string();
        assert!(!serialized.contains("private title"));
        assert!(!serialized.contains(phrase.as_str()));
        let backup: Backup = serde_json::from_value(wrapped).unwrap();
        assert_eq!(decode_backup(&backup, &restored).unwrap(), value);
        let (_, wrong) = make_recovery(&[20; 32]).unwrap();
        assert!(recover_key(&recovery, &wrong).is_err());
        assert!(recover_key(&recovery, "wrong phrase").is_err());
    }
    #[test]
    fn backup_and_recovery_metadata_tampering_is_rejected() {
        let master = LibraryKey::from_bytes([21; 32]);
        let (recovery, phrase) = make_recovery(master.bytes()).unwrap();
        let mut changed = recovery.clone();
        changed.id = Uuid::new_v4().to_string();
        assert!(recover_key(&changed, &phrase).is_err());
        let mut value = seal_backup(&master, &recovery, b"{\"secret\":true}").unwrap();
        value["id"] = json!(Uuid::new_v4().to_string());
        let backup: Backup = serde_json::from_value(value).unwrap();
        assert!(decode_backup(&backup, master.bytes()).is_err());
    }
}
