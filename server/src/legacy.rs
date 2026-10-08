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
fn terminal(session: &Value) -> bool {
    matches!(
        session["status"].as_str(),
        Some("completed" | "failed" | "interrupted")
    ) && session["audioAvailable"] == true
}
/// Read WAV structure and reject the unfinalized zero-length headers of an active capture.
fn finalized_wav(path: &FsPath) -> Result<(u64, f64), ApiError> {
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
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
            let Ok(bytes) = fs::read(folder.join("session.json")) else {
                continue;
            };
            let Ok(session) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let ready = terminal(&session) && finalized_wav(&folder.join("meeting.wav")).is_ok();
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
    let session: Value = serde_json::from_slice(&fs::read(folder.join("session.json"))?)?;
    if !terminal(&session) {
        return Err(ApiError::new(
            409,
            "Stop the old helper before recovering its audio. No active markers were removed.",
        ));
    }
    let audio = folder.join("meeting.wav");
    let (_, duration) = finalized_wav(&audio)?;
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
    let mut file = fs::File::open(audio)?;
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
        let value: Value = serde_json::from_slice(&fs::read(&marker)?)?;
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
        let dir = tempfile::tempdir().unwrap();
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
