use super::*;

/// Canonicalize supported audio MIME types and reject unknown containers.
pub(super) fn audio_type(value: &str) -> Result<String> {
    let base = value.split(';').next().unwrap_or("").trim().to_lowercase();
    if ![
        "audio/webm",
        "video/webm",
        "audio/ogg",
        "audio/wav",
        "audio/x-wav",
        "audio/mpeg",
        "audio/mp3",
        "audio/mp4",
        "video/mp4",
        "audio/x-m4a",
        "audio/flac",
    ]
    .contains(&base.as_str())
    {
        return Err(ApiError::new(
            415,
            "Use a WebM, Ogg, WAV, MP3, MP4/M4A, or FLAC audio file.",
        ));
    }
    Ok(base)
}
/// Check container signatures before accepting bytes as the declared audio type.
pub(super) fn audio_header(data: &[u8], mime: &str) -> Result<()> {
    let valid = if mime.contains("webm") {
        data.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
    } else if mime.contains("ogg") {
        data.starts_with(b"OggS")
    } else if mime.contains("wav") {
        (data.starts_with(b"RIFF") || data.starts_with(b"RF64")) && data.get(8..12) == Some(b"WAVE")
    } else if mime.contains("flac") {
        data.starts_with(b"fLaC")
    } else if mime.contains("mp4") || mime.contains("m4a") {
        data.get(4..8) == Some(b"ftyp")
    } else {
        data.starts_with(b"ID3")
            || (data.first() == Some(&0xff)
                && data.get(1).map(|b| b & 0xe0 == 0xe0).unwrap_or(false))
    };
    if !valid {
        return Err(ApiError::new(415,"This file does not contain a supported audio recording. Choose an original audio file."));
    }
    Ok(())
}
/// Construct a same-origin playback path for a meeting's managed track.
pub(super) fn audio_url(meeting: &str, track: &str) -> String {
    format!("/api/meetings/{meeting}/audio/{track}")
}
/// Append a durable audio chunk; identical sequence/hash retries do not duplicate bytes.
pub fn add_audio(
    key: &str,
    data: &[u8],
    track_id: Option<&str>,
    label: &str,
    mime: &str,
    sequence: Option<i64>,
) -> Result<Value> {
    valid_id(key)?;
    let generated = id();
    let track_id = track_id.unwrap_or(&generated);
    valid_id(track_id)?;
    let mime = audio_type(mime)?;
    if label.is_empty() || label.len() > 200 {
        return Err(ApiError::bad(
            "An audio track requires a label under 200 characters.",
        ));
    }
    if data.is_empty() {
        return Err(ApiError::bad("The audio file is empty."));
    }
    if data.len() > MAX_AUDIO {
        return Err(ApiError::new(
            413,
            "Each audio upload must be smaller than 128 MB.",
        ));
    }
    if sequence
        .map(|s| !(0..=1_000_000).contains(&s))
        .unwrap_or(false)
    {
        return Err(ApiError::bad("Invalid audio sequence."));
    }
    let digest = format!("{:x}", Sha256::digest(data));
    let mut written: Option<PathBuf> = None;
    let result = with_db(|db| {
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        if m.get("extensionRecording").is_some() {
            return Err(ApiError::new(
                409,
                "Extension recordings accept audio through their capture connection.",
            ));
        }
        let existing_track = m["tracks"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .iter()
            .find(|t| t["id"] == track_id)
            .cloned();
        let last: Option<i64> = tx.query_row(
            "SELECT MAX(sequence) FROM audio_chunks WHERE meeting_id=? AND track_id=?",
            params![key, track_id],
            |r| r.get(0),
        )?;
        let seq = sequence.unwrap_or(last.map(|s| s + 1).unwrap_or(0));
        let existing: Option<(String, String, u64)> = tx
            .query_row(
                "SELECT digest,file,bytes FROM audio_chunks WHERE meeting_id=? AND track_id=? AND sequence=?",
                params![key, track_id, seq],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        if let Some((hash, file, bytes)) = existing {
            if hash != digest {
                return Err(ApiError::new(409,"A different audio chunk already uses this sequence. Retry its original content."));
            }
            if Path::new(&file).file_name().and_then(|name| name.to_str()) != Some(file.as_str()) {
                return Err(ApiError::new(500, "Invalid saved audio reference."));
            }
            let path = data_dir()?.join("audio").join(key).join(file);
            let saved = read_protected(&path)?;
            if saved.len() as u64 != bytes || format!("{:x}", Sha256::digest(&saved)) != hash {
                return Err(ApiError::new(
                    410,
                    "The saved audio chunk is damaged. Restore the recording from a backup.",
                ));
            }
            fs::File::open(&path)?.sync_all()?;
            fs::File::open(
                path.parent()
                    .ok_or_else(|| ApiError::new(500, "Invalid audio path."))?,
            )?
            .sync_all()?;
            return existing_track.ok_or_else(|| {
                ApiError::new(500, "The audio index is damaged. Restore from a backup.")
            });
        }
        if seq != last.map(|s| s + 1).unwrap_or(0) {
            return Err(ApiError::new(
                409,
                "Audio arrived out of order. Retry the missing chunk before continuing.",
            ));
        }
        if seq == 0 {
            audio_header(data, &mime)?;
        }
        if let Some(t) = &existing_track {
            if t["mimeType"] != mime {
                return Err(ApiError::new(
                    409,
                    "The recording format changed. Start a new track.",
                ));
            }
        } else if m["tracks"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .len()
            >= 20
        {
            return Err(ApiError::bad(
                "A meeting can contain at most 20 audio tracks.",
            ));
        }
        let bytes = existing_track
            .as_ref()
            .and_then(|t| t["bytes"].as_u64())
            .unwrap_or(0)
            + data.len() as u64;
        if bytes > 2 * 1024 * 1024 * 1024 {
            return Err(ApiError::new(
                413,
                "This track reached 2 GB. Save it and start another meeting.",
            ));
        }
        let dir = data_dir()?.join("audio").join(key);
        mkdir(&dir)?;
        let name = format!("{track_id}-{seq}-{}.chunk", id());
        let path = dir.join(&name);
        written = Some(path.clone());
        write_protected(&path, data)?;
        fs::File::open(&dir)?.sync_all()?;
        fs::File::open(
            dir.parent()
                .ok_or_else(|| ApiError::new(500, "Invalid audio directory."))?,
        )?
        .sync_all()?;
        tx.execute(
            "INSERT INTO audio_chunks VALUES(?,?,?,?,?,?)",
            params![key, track_id, seq, name, data.len() as i64, digest],
        )?;
        let track = json!({"id":track_id,"label":label,"mimeType":mime,"bytes":bytes,"url":audio_url(key,track_id)});
        let tracks = m["tracks"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        if let Some(existing) = tracks.iter_mut().find(|t| t["id"] == track_id) {
            *existing = track.clone();
        } else {
            tracks.push(track.clone());
        }
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(track)
    });
    if result.is_err() {
        if let Some(p) = written {
            let _ = fs::remove_file(p);
        }
    }
    result
}
#[derive(Debug, Clone)]
pub struct AudioPart {
    pub path: PathBuf,
    pub bytes: u64,
}
/// Resolve ordered track chunks and verify their managed files for streaming playback.
pub fn get_audio_parts(key: &str, track_id: &str) -> Result<(Value, Vec<AudioPart>)> {
    valid_id(track_id)?;
    with_db(|db| {
        let m = require_meeting(db, key)?;
        let track = m["tracks"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .iter()
            .find(|t| t["id"] == track_id)
            .cloned()
            .ok_or_else(|| ApiError::new(404, "This audio track is no longer available."))?;
        let mut stmt=db.prepare("SELECT file,bytes FROM audio_chunks WHERE meeting_id=? AND track_id=? ORDER BY sequence")?;
        let rows = stmt.query_map(params![key, track_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, u64>(1)?))
        })?;
        let mut parts = Vec::new();
        for row in rows {
            let (file, bytes) = row?;
            if Path::new(&file).file_name().and_then(|s| s.to_str()) != Some(&file) {
                return Err(ApiError::new(500, "Invalid saved audio reference."));
            }
            let path = data_dir()?.join("audio").join(key).join(file);
            if !path.exists()
                || fs::symlink_metadata(&path)?.file_type().is_symlink()
                || protected_reader(&path)
                    .map_err(|_| {
                        ApiError::new(
                            410,
                            "Saved audio failed authentication. Restore it from a backup.",
                        )
                    })?
                    .len()
                    != bytes
            {
                return Err(ApiError::new(410,"Saved audio files are missing or damaged. Restore the recording from a backup; saved text remains available."));
            }
            parts.push(AudioPart { path, bytes });
        }
        if parts.iter().map(|p| p.bytes).sum::<u64>() != track["bytes"].as_u64().unwrap_or(0) {
            return Err(ApiError::new(
                410,
                "This recording is incomplete. Restore it from a backup.",
            ));
        }
        Ok((track, parts))
    })
}
