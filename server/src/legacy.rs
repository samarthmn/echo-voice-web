//! Read-only discovery and explicit recovery of finalized, retired runner recordings.
//! Never launch a runner or remove its private browser profile.
use crate::{security::ApiError, store};
use axum::{
    extract::Path,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path as FsPath, PathBuf},
};

pub fn routes() -> Router {
    Router::new()
        .route("/extensions/legacy-recordings", get(list))
        .route("/extensions/legacy-recordings/{id}/recover", post(recover))
}
fn managed_folder(id: &str) -> Result<PathBuf, ApiError> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(ApiError::bad("Invalid old recording ID."));
    }
    let root = store::data_dir().join("bot");
    let folder = root.join(id);
    for path in [
        &root,
        &folder,
        &folder.join("session.json"),
        &folder.join("meeting.wav"),
    ] {
        if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(ApiError::bad("Old recording links cannot be recovered."));
        }
    }
    Ok(folder)
}

/// Dual reads are confined to retired runner migration. Existing active runner
/// markers stay readable and deletion guards remain conservative.
pub(crate) fn read_metadata(path: &FsPath) -> Result<Value, ApiError> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(ApiError::bad("Old recording links cannot be recovered."));
    }
    let bytes = if crate::protected_storage::is_encrypted(path)? {
        store::read_protected(path)?
    } else {
        if fs::metadata(path)?.len() > 1024 * 1024 {
            return Err(ApiError::bad("Old recording metadata is too large."));
        }
        fs::read(path)?
    };
    Ok(serde_json::from_slice(&bytes)?)
}
fn protect(path: &FsPath) -> Result<(), ApiError> {
    if path.exists() && !crate::protected_storage::is_encrypted(path)? {
        if fs::metadata(path)?.len() > 512 * 1024 * 1024 {
            return Err(ApiError::new(413,"An old recording exceeds the protected migration limit. Its original is preserved."));
        }
        let bytes = zeroize::Zeroizing::new(fs::read(path)?);
        store::replace_protected(path, &bytes)?;
    }
    Ok(())
}
fn active(session: &Value) -> bool {
    matches!(
        session["status"].as_str(),
        Some("joining" | "waiting" | "recording" | "stopping")
    )
}
fn stopped(session: &Value) -> bool {
    matches!(
        session["status"].as_str(),
        Some("completed" | "failed" | "interrupted")
    )
}
fn pending_capture() -> ApiError {
    ApiError::new(409, "Stop the old meeting assistant and finalize or recover its pending recording before opening this library with protected storage. Its original database, audio, and active markers have been preserved.")
}
/// Read-only preflight before key creation or database migration. An encrypted
/// session asks the caller to unlock its existing key, then repeat this check;
/// it never justifies creating a replacement key or skipping capture guards.
pub(crate) fn preflight(
    root: &FsPath,
    key: Option<&crate::protected_storage::LibraryKey>,
) -> Result<bool, ApiError> {
    let mut encrypted = false;
    let read = |path: &FsPath, encrypted: &mut bool| -> Result<Option<Value>, ApiError> {
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(pending_capture());
        }
        let bytes = if crate::protected_storage::is_encrypted(path)? {
            *encrypted = true;
            let Some(key) = key else {
                return Ok(None);
            };
            let relative = path.strip_prefix(root).map_err(|_| pending_capture())?;
            let context = relative.to_string_lossy().replace('\\', "/");
            let mut reader = crate::protected_storage::Reader::open(key, path, &context)?;
            if reader.len() > 1024 * 1024 {
                return Err(pending_capture());
            }
            reader.read_all()?
        } else {
            if fs::metadata(path)?.len() > 1024 * 1024 {
                return Err(pending_capture());
            }
            fs::read(path)?
        };
        Ok(Some(
            serde_json::from_slice(&bytes).map_err(|_| pending_capture())?,
        ))
    };
    let bot = root.join("bot");
    if bot.exists() {
        if fs::symlink_metadata(&bot)?.file_type().is_symlink() {
            return Err(pending_capture());
        }
        for entry in fs::read_dir(&bot)? {
            let entry = entry?;
            if entry.file_type()?.is_symlink() {
                return Err(pending_capture());
            }
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let session = entry.path().join("session.json");
            if session.exists() {
                if let Some(value) = read(&session, &mut encrypted)? {
                    if !stopped(&value) {
                        return Err(pending_capture());
                    }
                }
            } else if entry.path().join("meeting.wav").exists() {
                return Err(pending_capture());
            }
        }
    }
    for name in ["bot-starts", "assistant-starts"] {
        let starts = root.join(name);
        if !starts.exists() {
            continue;
        }
        if fs::symlink_metadata(&starts)?.file_type().is_symlink() {
            return Err(pending_capture());
        }
        for entry in fs::read_dir(&starts)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() || entry.path().extension().is_none_or(|v| v != "json")
            {
                return Err(pending_capture());
            }
            let Some(id) = entry
                .path()
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_owned)
            else {
                return Err(pending_capture());
            };
            if id.is_empty()
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(pending_capture());
            }
            let marker = read(&entry.path(), &mut encrypted)?;
            let session = bot.join(id).join("session.json");
            if !session.exists() {
                return Err(pending_capture());
            }
            let session = read(&session, &mut encrypted)?;
            if let (Some(marker), Some(session)) = (marker, session) {
                if !terminal(&session)
                    || !marker["requestId"].is_string()
                    || marker["requestId"] != session["requestId"]
                {
                    return Err(pending_capture());
                }
            }
        }
    }
    Ok(encrypted)
}
/// Authenticate all copied legacy files and require a stopped session before
/// the desktop launcher selects the copy or transfers its optional account.
pub(crate) fn validate_copy() -> Result<(), ApiError> {
    let root = store::data_dir();
    store::with_key(|key| {
        preflight(&root, Some(key))
            .map(|_| ())
            .map_err(std::io::Error::other)
    })?;
    let bot = root.join("bot");
    if !bot.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(bot)? {
        let folder = entry?.path();
        if !folder.is_dir() || !folder.join("session.json").is_file() {
            continue;
        }
        let session = read_metadata(&folder.join("session.json"))?;
        if !stopped(&session) {
            return Err(pending_capture());
        }
        let audio = folder.join("meeting.wav");
        if session["audioAvailable"] == true {
            finalized_wav(&audio)?;
        }
        if audio.exists() {
            let mut reader = store::protected_reader(&audio)?;
            let mut offset = 0;
            while offset < reader.len() {
                let count = (reader.len() - offset).min(65_536) as usize;
                reader.read_range(offset, count)?;
                offset += count as u64;
            }
        }
    }
    Ok(())
}
fn protect_folder(folder: &FsPath, session: &Value) -> Result<(), ApiError> {
    if active(session) {
        return Ok(());
    }
    for name in ["meeting.wav", "session.json"] {
        protect(&folder.join(name))?;
    }
    Ok(())
}
pub(crate) fn protect_retired_recordings() -> Result<(), ApiError> {
    let root = store::data_dir().join("bot");
    if root.exists() {
        if fs::symlink_metadata(&root)?.file_type().is_symlink() {
            return Err(ApiError::bad("Old recording links cannot be recovered."));
        }
        for entry in fs::read_dir(&root)? {
            let entry = entry?;
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let folder = managed_folder(&id)?;
            if folder.join("session.json").is_file() {
                let session = read_metadata(&folder.join("session.json"))?;
                if active(&session) {
                    return Err(ApiError::new(409, "Stop the old meeting assistant and finalize its recording before opening this library with protected storage. Its audio and active deletion guards have been preserved."));
                }
                protect_folder(&folder, &session)?;
            }
        }
    }
    let starts = store::data_dir().join("bot-starts");
    if starts.exists() {
        if fs::symlink_metadata(&starts)?.file_type().is_symlink() {
            return Err(ApiError::bad("Old recording links cannot be recovered."));
        }
        for entry in fs::read_dir(starts)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|v| v == "json") {
                protect(&entry.path())?;
            }
        }
    }
    Ok(())
}
enum LegacySource {
    Plain(fs::File),
    Protected(Box<crate::protected_storage::Reader>),
}
struct LegacyFile {
    source: LegacySource,
    offset: u64,
    length: u64,
}
impl LegacyFile {
    fn open(path: &FsPath) -> Result<Self, ApiError> {
        let (source, length) = if crate::protected_storage::is_encrypted(path)? {
            let reader = store::protected_reader(path)?;
            let length = reader.len();
            (LegacySource::Protected(Box::new(reader)), length)
        } else {
            let file = fs::File::open(path)?;
            let length = file.metadata()?.len();
            (LegacySource::Plain(file), length)
        };
        Ok(Self {
            source,
            offset: 0,
            length,
        })
    }
}
impl Read for LegacyFile {
    fn read(&mut self, output: &mut [u8]) -> std::io::Result<usize> {
        let count = (self.length.saturating_sub(self.offset) as usize).min(output.len());
        let count = match &mut self.source {
            LegacySource::Plain(file) => file.read(&mut output[..count])?,
            LegacySource::Protected(reader) => {
                let bytes = reader.read_range(self.offset, count)?;
                output[..bytes.len()].copy_from_slice(&bytes);
                bytes.len()
            }
        };
        self.offset += count as u64;
        Ok(count)
    }
}
impl Seek for LegacyFile {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let offset = match position {
            SeekFrom::Start(v) => v as i128,
            SeekFrom::End(v) => self.length as i128 + v as i128,
            SeekFrom::Current(v) => self.offset as i128 + v as i128,
        };
        if offset < 0 || offset > self.length as i128 {
            return Err(std::io::Error::other("Invalid old recording offset."));
        }
        self.offset = offset as u64;
        if let LegacySource::Plain(file) = &mut self.source {
            file.seek(SeekFrom::Start(self.offset))?;
        }
        Ok(self.offset)
    }
}

fn terminal(session: &Value) -> bool {
    matches!(
        session["status"].as_str(),
        Some("completed" | "failed" | "interrupted")
    ) && session["audioAvailable"] == true
}
/// Read WAV structure and reject the unfinalized zero-length headers of an active capture.
fn finalized_wav(path: &FsPath) -> Result<(u64, f64), ApiError> {
    let mut file = LegacyFile::open(path)?;
    let size = file.length;
    if size > 512 * 1024 * 1024 {
        return Err(ApiError::new(
            413,
            "Recover WAV files larger than 512 MB manually using the migration guide.",
        ));
    }
    let mut header = [0u8; 12];
    file.read_exact(&mut header)?;
    if &header[..4] != b"RIFF"
        || &header[8..] != b"WAVE"
        || u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8 != size
    {
        return Err(ApiError::bad(
            "This WAV has not been finalized. Stop the old helper first.",
        ));
    }
    let mut rate = None;
    let mut block = None;
    let mut frames = None;
    let mut offset = 12u64;
    while offset + 8 <= size {
        file.seek(SeekFrom::Start(offset))?;
        let mut chunk = [0u8; 8];
        file.read_exact(&mut chunk)?;
        let bytes = u32::from_le_bytes(chunk[4..].try_into().unwrap()) as u64;
        if offset + 8 + bytes > size {
            return Err(ApiError::bad("Old WAV audio is incomplete."));
        }
        if &chunk[..4] == b"fmt " {
            if bytes < 16 {
                return Err(ApiError::bad("Old WAV format is invalid."));
            }
            let mut fmt = [0u8; 16];
            file.read_exact(&mut fmt)?;
            let encoding = u16::from_le_bytes(fmt[..2].try_into().unwrap());
            let channels = u16::from_le_bytes(fmt[2..4].try_into().unwrap());
            let hz = u32::from_le_bytes(fmt[4..8].try_into().unwrap());
            let alignment = u16::from_le_bytes(fmt[12..14].try_into().unwrap());
            if ![1, 3].contains(&encoding)
                || !(1..=2).contains(&channels)
                || !(8000..=192000).contains(&hz)
                || alignment == 0
            {
                return Err(ApiError::bad("Unsupported old WAV format."));
            }
            rate = Some(hz);
            block = Some(alignment);
        } else if &chunk[..4] == b"data" {
            if bytes == 0 {
                return Err(ApiError::bad("Old WAV contains no finalized samples."));
            }
            frames = Some(bytes);
        }
        offset += 8 + bytes + (bytes % 2);
    }
    let rate = rate.ok_or_else(|| ApiError::bad("Old WAV format is missing."))?;
    let block = block.ok_or_else(|| ApiError::bad("Old WAV format is missing."))? as u64;
    let bytes = frames.ok_or_else(|| ApiError::bad("Old WAV samples are missing."))?;
    if bytes % block != 0 {
        return Err(ApiError::bad("Old WAV ends in a partial audio frame."));
    }
    Ok((size, bytes as f64 / block as f64 / rate as f64))
}
async fn list() -> Result<Json<Value>, ApiError> {
    let mut recordings = Vec::new();
    let root = store::data_dir().join("bot");
    if root.is_dir() && !fs::symlink_metadata(&root)?.file_type().is_symlink() {
        for entry in fs::read_dir(root)? {
            let entry = entry?;
            let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let Ok(folder) = managed_folder(&id) else {
                continue;
            };
            let Ok(session) = read_metadata(&folder.join("session.json")) else {
                continue;
            };
            let ready = terminal(&session) && finalized_wav(&folder.join("meeting.wav")).is_ok();
            if ready {
                protect_folder(&folder, &session)?;
            }
            recordings.push(json!({"meetingId":id,"ready":ready,"status":session["status"],"detail":if ready{"Finalized audio can be recovered."}else{"Stop the old helper and finalize audio before recovery. Existing deletion guards remain active."}}));
        }
    }
    Ok(Json(json!({"protocolVersion":1,"recordings":recordings})))
}
async fn recover(Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    tokio::task::spawn_blocking(move || recover_recording(&id))
        .await
        .map_err(|_| {
            ApiError::new(
                500,
                "Old audio recovery did not finish. Retry; the original is preserved.",
            )
        })?
        .map(Json)
}
fn recover_recording(id: &str) -> Result<Value, ApiError> {
    let folder = managed_folder(id)?;
    let session = read_metadata(&folder.join("session.json"))?;
    if !terminal(&session) {
        return Err(ApiError::new(
            409,
            "Stop the old helper before recovering its audio. No active markers were removed.",
        ));
    }
    let audio = folder.join("meeting.wav");
    let (_, duration) = finalized_wav(&audio)?;
    protect_folder(&folder, &session)?;
    let meeting = store::get_meeting(id)?.ok_or_else(ApiError::not_found)?;
    if matches!(
        meeting["status"].as_str(),
        Some("recording" | "paused" | "processing")
    ) {
        return Err(ApiError::new(
            409,
            "Stop recording or processing before recovering old audio.",
        ));
    }
    // Preserve the retired importer's 64 MiB chunk boundaries so partial imports
    // and lost acknowledgements can resume using the same track/sequence identities.
    let mut file = LegacyFile::open(&audio)?;
    let mut sequence = 0;
    loop {
        let mut bytes = vec![0; 64 * 1024 * 1024];
        let mut count = 0;
        while count < bytes.len() {
            let read = file.read(&mut bytes[count..])?;
            if read == 0 {
                break;
            }
            count += read;
        }
        if count == 0 {
            break;
        }
        bytes.truncate(count);
        store::add_audio(
            id,
            &bytes,
            Some("meeting-bot"),
            "Recovered meeting audio",
            "audio/wav",
            Some(sequence),
        )?;
        sequence += 1;
    }
    let updated = if meeting["transcripts"]
        .as_array()
        .is_some_and(|v| !v.is_empty())
    {
        meeting
    } else {
        store::update_meeting(id, json!({"duration":duration,"status":"saved","error":""}))?
    };
    // Only a finalized matching session may retire its uncertain-start marker.
    let marker = store::data_dir()
        .join("bot-starts")
        .join(format!("{id}.json"));
    if marker.is_file() && !fs::symlink_metadata(&marker)?.file_type().is_symlink() {
        let value = read_metadata(&marker)?;
        if value["requestId"].is_string() && value["requestId"] == session["requestId"] {
            fs::remove_file(marker)?;
        }
    }
    Ok(json!({"protocolVersion":1,"meeting":updated}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copied_finalized_audio_authenticates_blocks_beyond_the_wav_header() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        let folder = directory.path().join("bot/copy-test");
        fs::create_dir_all(&folder).unwrap();
        let mut audio = vec![0u8; 70_044];
        audio[..4].copy_from_slice(b"RIFF");
        audio[4..8].copy_from_slice(&70_036u32.to_le_bytes());
        audio[8..12].copy_from_slice(b"WAVE");
        audio[12..16].copy_from_slice(b"fmt ");
        audio[16..20].copy_from_slice(&16u32.to_le_bytes());
        audio[20..22].copy_from_slice(&1u16.to_le_bytes());
        audio[22..24].copy_from_slice(&1u16.to_le_bytes());
        audio[24..28].copy_from_slice(&16000u32.to_le_bytes());
        audio[32..34].copy_from_slice(&2u16.to_le_bytes());
        audio[34..36].copy_from_slice(&16u16.to_le_bytes());
        audio[36..40].copy_from_slice(b"data");
        audio[40..44].copy_from_slice(&70_000u32.to_le_bytes());
        let path = folder.join("meeting.wav");
        store::write_protected(&path, &audio).unwrap();
        store::write_protected(
            &folder.join("session.json"),
            br#"{"status":"completed","audioAvailable":true}"#,
        )
        .unwrap();
        validate_copy().unwrap();
        let mut disk = fs::read(&path).unwrap();
        let last = disk.len() - 1;
        disk[last] ^= 1;
        fs::write(&path, &disk).unwrap();
        assert!(finalized_wav(&path).is_ok());
        assert!(validate_copy().is_err());
        assert_eq!(fs::read(&path).unwrap(), disk);
        store::reset_for_tests();
    }
    #[test]
    fn plaintext_active_capture_and_unresolved_start_refuse_before_key_or_database_changes() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        std::env::set_var("ECHO_TEST_MODE", "1");
        // If preflight accidentally loads a key it must fail without touching
        // any real credential store. The required result is the earlier 409.
        std::env::set_var("ECHO_TEST_STORAGE_KEY", "not-a-key");
        let database = directory.path().join("workspace.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection.execute_batch("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('preserve legacy database');").unwrap();
        drop(connection);
        let before = fs::read(&database).unwrap();
        let folder = directory.path().join("bot/legacy-active");
        fs::create_dir_all(&folder).unwrap();
        let audio = b"unfinished capture remains byte-for-byte unchanged";
        fs::write(folder.join("meeting.wav"), audio).unwrap();
        for status in ["joining", "waiting", "recording", "stopping", "unknown"] {
            let session = serde_json::to_vec(&json!({"status":status})).unwrap();
            fs::write(folder.join("session.json"), &session).unwrap();
            assert_eq!(store::init().unwrap_err().status.as_u16(), 409);
            assert_eq!(fs::read(&database).unwrap(), before);
            assert_eq!(fs::read(folder.join("meeting.wav")).unwrap(), audio);
            assert_eq!(fs::read(folder.join("session.json")).unwrap(), session);
            assert!(!directory.path().join("protection.json").exists());
        }
        fs::write(
            folder.join("session.json"),
            br#"{"status":"completed","audioAvailable":true,"requestId":"finished"}"#,
        )
        .unwrap();
        for name in ["bot-starts", "assistant-starts"] {
            let starts = directory.path().join(name);
            fs::create_dir(&starts).unwrap();
            let marker = starts.join("legacy-active.json");
            fs::write(&marker, br#"{"requestId":"still-pending"}"#).unwrap();
            assert_eq!(store::init().unwrap_err().status.as_u16(), 409);
            assert_eq!(fs::read(&database).unwrap(), before);
            assert!(marker.exists());
            assert!(!directory.path().join("protection.json").exists());
            fs::remove_dir_all(starts).unwrap();
        }
        store::test_key();
        store::reset_for_tests();
    }
    #[test]
    fn encrypted_active_session_is_authenticated_before_database_conversion() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        let database = directory.path().join("workspace.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE original(value TEXT);")
            .unwrap();
        drop(connection);
        let before = fs::read(&database).unwrap();
        let folder = directory.path().join("bot/encrypted-session");
        fs::create_dir_all(&folder).unwrap();
        let session = folder.join("session.json");
        crate::protected_storage::write_file(
            &crate::protected_storage::LibraryKey::from_bytes([42; 32]),
            &session,
            "bot/encrypted-session/session.json",
            br#"{"status":"recording"}"#,
        )
        .unwrap();
        let original = fs::read(&session).unwrap();
        assert_eq!(store::init().unwrap_err().status.as_u16(), 409);
        assert_eq!(fs::read(&database).unwrap(), before);
        assert_eq!(fs::read(&session).unwrap(), original);
        std::env::set_var("ECHO_TEST_MODE", "0");
        assert!(store::init()
            .unwrap_err()
            .message
            .contains("no new key or database"));
        assert!(!directory.path().join("protection.json").exists());
        store::test_key();
        store::reset_for_tests();
    }
    #[test]
    fn startup_refuses_active_plaintext_then_encrypts_finalized_recovery_metadata() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        let folder = directory.path().join("bot/retired-capture");
        fs::create_dir_all(&folder).unwrap();
        let audio = b"original finalized audio retained for recovery";
        fs::write(folder.join("meeting.wav"), audio).unwrap();
        fs::write(
            folder.join("session.json"),
            br#"{"status":"recording","audioAvailable":true}"#,
        )
        .unwrap();
        store::reset_for_tests();
        let failure = store::init().unwrap_err();
        assert_eq!(failure.status.as_u16(), 409);
        assert!(failure.message.contains("Stop the old meeting assistant"));
        assert_eq!(fs::read(folder.join("meeting.wav")).unwrap(), audio);
        fs::write(
            folder.join("session.json"),
            br#"{"status":"completed","audioAvailable":true}"#,
        )
        .unwrap();
        store::init().unwrap();
        assert!(fs::read(folder.join("meeting.wav"))
            .unwrap()
            .starts_with(b"ECHOENC1"));
        assert_eq!(
            store::read_protected(&folder.join("meeting.wav")).unwrap(),
            audio
        );
        assert_eq!(
            read_metadata(&folder.join("session.json")).unwrap()["status"],
            "completed"
        );
        store::reset_for_tests();
    }
    #[test]
    fn recovery_rejects_live_or_unfinalized_audio() {
        assert!(!terminal(
            &json!({"status":"recording","audioAvailable":true})
        ));
        assert!(!terminal(
            &json!({"status":"completed","audioAvailable":false})
        ));
        assert!(terminal(
            &json!({"status":"completed","audioAvailable":true})
        ));
        assert!(managed_folder("../../credentials").is_err());
        let root = FsPath::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tmp");
        fs::create_dir_all(&root).unwrap();
        let dir = tempfile::Builder::new()
            .prefix("legacy-protection-test-")
            .tempdir_in(root)
            .unwrap();
        let path = dir.path().join("old.wav");
        let mut bytes = vec![0u8; 48];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&40u32.to_le_bytes());
        bytes[8..12].copy_from_slice(b"WAVE");
        bytes[12..16].copy_from_slice(b"fmt ");
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&16000u32.to_le_bytes());
        bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
        bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&4u32.to_le_bytes());
        fs::write(&path, &bytes).unwrap();
        assert_eq!(finalized_wav(&path).unwrap(), (48, 2. / 16000.));
        bytes[40..44].copy_from_slice(&0u32.to_le_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(finalized_wav(&path).is_err());
    }
}
