use super::*;

pub(super) async fn start(
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    store::run(move |db| {
    uid(&id)?;
    fields(
        &v,
        &[
            "title",
            "provider",
            "meetingUrl",
            "consent",
            "liveTranscription",
            "sampleRate",
            "channels",
            "createdAt",
        ],
    )?;
    text(&v, "title", 300)?;
    if v["consent"] != true
        || v["sampleRate"] != RATE
        || v["channels"] != 1
        || !v["liveTranscription"].is_boolean()
    {
        return Err(ApiError::bad("Consent and mono 16 kHz PCM are required."));
    }
    let provider = text(&v, "provider", 30)?;
    let raw = text(&v, "meetingUrl", 2000)?;
    let url = url::Url::parse(raw).map_err(|_| ApiError::bad("Invalid meeting URL."))?;
    let valid = match provider {
        "meet" | "google-meet" => url.host_str() == Some("meet.google.com"),
        "zoom" => url
            .host_str()
            .is_some_and(|h| h == "zoom.us" || h.ends_with(".zoom.us") || h == "app.zoom.com"),
        "teams" => matches!(
            url.host_str(),
            Some("teams.microsoft.com" | "teams.live.com" | "teams.cloud.microsoft")
        ),
        _ => false,
    };
    if !valid
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || raw.contains(['\r', '\n'])
    {
        return Err(ApiError::bad("Use a supported HTTPS meeting URL."));
    }
    chrono::DateTime::parse_from_rfc3339(text(&v, "createdAt", 100)?)
        .map_err(|_| ApiError::bad("Invalid creation time."))?;
        let tx = db.transaction()?;
        let install = authenticated(&tx, &headers)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT data FROM extension_recordings WHERE recording_id=?",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let lib = library(&tx)?;
        if let Some(raw) = existing {
            let r: Value = serde_json::from_str(&raw)?;
            if r["installationId"] != install {
                return Err(ApiError::new(
                    403,
                    "Recording belongs to another installation.",
                ));
            }
            if r["status"] == "receiving" && r["input"] != v {
                return Err(ApiError::new(
                    409,
                    "Recording metadata conflicts with the saved session.",
                ));
            }
            verify_complete_files(&tx, &r)?;
            return Ok(reply(extension_recording(r, &lib)?));
        }
        let count:i64=tx.query_row("SELECT COUNT(*) FROM extension_recordings WHERE installation_id=? AND json_extract(data,'$.status')='receiving'",[&install],|r|r.get(0))?;
        if count >= 20 {
            return Err(ApiError::new(
                429,
                "Synchronize outstanding recordings first.",
            ));
        }
        let meeting = Uuid::new_v4().to_string();
        let settings = store::settings_db(&tx)?;
        let mut m = json!({"id":meeting,"title":v["title"],"mode":"online","consent":true,"meetingUrl":v["meetingUrl"],"liveTranscription":v["liveTranscription"],"status":"recording","createdAt":v["createdAt"],"updatedAt":store::now(),"duration":0,"speechModel":settings["speechModel"],"notesModel":settings["notesModel"],"tracks":[],"transcripts":[],"notes":[],"moments":[],"gaps":[],"extensionRecording":{"recordingId":id,"installationId":install,"libraryId":lib,"partTrackIds":[],"totalFrames":0,"sampleRate":RATE}});
        if let Some(event_id) =
            crate::integrations::associated_calendar_event(raw, text(&v, "createdAt", 100)?)
        {
            m["calendarEventId"] = json!(event_id);
        }
        store::validate_meeting(&m)?;
        tx.execute(
            "INSERT INTO meetings VALUES(?,?)",
            params![meeting, m.to_string()],
        )?;
        let r = json!({"recordingId":id,"installationId":install,"meetingId":meeting,"status":"receiving","nextSequence":0,"totalFrames":0,"liveTranscription":v["liveTranscription"],"createdAt":v["createdAt"],"title":v["title"],"provider":v["provider"],"controls":[],"controlHistory":{},"generation":0,"input":v});
        tx.execute(
            "INSERT INTO extension_recordings VALUES(?,?,?,?)",
            params![id, install, meeting, r.to_string()],
        )?;
        tx.commit()?;
        Ok(reply(extension_recording(r, &lib)?))
    }).await
}
fn verify_complete_files(db: &Connection, r: &Value) -> Result<()> {
    if r["status"] != "complete" {
        return Ok(());
    }
    let meeting_id = r["meetingId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
    let meeting = store::require_meeting(db, meeting_id)?;
    store::validate_meeting(&meeting)?;
    let mut stmt = db.prepare("SELECT file,bytes,digest FROM audio_chunks WHERE meeting_id=?")?;
    let rows = stmt
        .query_map([meeting_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, u64>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let expected = meeting["tracks"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        .iter()
        .map(|t| {
            t["bytes"]
                .as_u64()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .sum::<u64>();
    if rows.iter().map(|row| row.1).sum::<u64>() != expected || rows.is_empty() {
        return Err(ApiError::new(410, "The completed audio index is incomplete. Keep your local recording and restore Echo audio."));
    }
    for (file, bytes, expected_digest) in rows {
        if std::path::Path::new(&file)
            .file_name()
            .and_then(|s| s.to_str())
            != Some(file.as_str())
        {
            return Err(ApiError::new(410, "Invalid completed audio reference."));
        }
        let path = store::data_dir()?.join("audio").join(meeting_id).join(file);
        let metadata = fs::symlink_metadata(&path).map_err(|_| {
            ApiError::new(
                410,
                "Completed audio is missing. Keep your local recording and restore Echo audio.",
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ApiError::new(410, "Invalid completed audio file."));
        }
        let damaged = || {
            ApiError::new(
                410,
                "Completed audio is damaged. Keep your local recording and restore Echo audio.",
            )
        };
        let mut reader = store::protected_reader(&path).map_err(|_| damaged())?;
        if reader.len() != bytes {
            return Err(damaged());
        }
        // The authenticated header only proves the length. Authenticate every
        // audio block and compare the complete plaintext digest before an
        // acknowledgement can allow the browser to discard its durable copy.
        // Read in bounded windows; never assemble an hours-long recording here.
        let mut digest = Sha256::new();
        let mut offset = 0;
        while offset < bytes {
            let count = (bytes - offset).min(1024 * 1024) as usize;
            let mut plaintext = reader.read_range(offset, count).map_err(|_| damaged())?;
            digest.update(&plaintext);
            plaintext.fill(0);
            offset += count as u64;
        }
        if format!("{:x}", digest.finalize()) != expected_digest {
            return Err(damaged());
        }
    }
    Ok(())
}
pub(super) async fn status(Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>> {
    store::run(move |db| {
        let r = owned(db, &headers, &id)?;
        verify_complete_files(db, &r)?;
        Ok(reply(extension_recording(r, &library(db)?)?))
    })
    .await
}
/// Only a short draft tail is exposed to the recording's authenticated installation.
pub(super) fn pcm_dir(id: &str) -> Result<PathBuf> {
    Ok(store::data_dir()?.join("extension-pcm").join(id))
}
#[cfg(test)]
#[derive(Default)]
pub(super) struct SyncFault {
    pub(super) path: PathBuf,
    pub(super) failures_remaining: usize,
    pub(super) calls: usize,
}
#[cfg(test)]
pub(super) static SYNC_FAULT: std::sync::Mutex<Option<SyncFault>> = std::sync::Mutex::new(None);
/// A retry must establish durability again, even when a previous attempt left valid bytes.
fn sync_path(path: &std::path::Path) -> Result<()> {
    #[cfg(test)]
    {
        let mut fault = SYNC_FAULT.lock().unwrap();
        if let Some(fault) = fault.as_mut().filter(|fault| fault.path == path) {
            fault.calls += 1;
            if fault.failures_remaining > 0 {
                fault.failures_remaining -= 1;
                return Err(std::io::Error::other("Injected audio durability failure.").into());
            }
        }
    }
    fs::File::open(path)?.sync_all()?;
    Ok(())
}
fn synced_directory(path: &std::path::Path) -> Result<()> {
    sync_path(path)
}
fn sync_audio(path: &std::path::Path, directory: &std::path::Path) -> Result<()> {
    sync_path(path)?;
    synced_directory(directory)
}
pub(super) fn chunk_path(id: &str, file: &str) -> Result<PathBuf> {
    if std::path::Path::new(file)
        .file_name()
        .and_then(|s| s.to_str())
        != Some(file)
    {
        return Err(ApiError::new(410, "Invalid saved PCM reference."));
    }
    Ok(pcm_dir(id)?.join(file))
}
pub(super) fn read_chunk(path: &std::path::Path, frames: u64, digest: &str) -> Result<Vec<u8>> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(ApiError::new(410, "A saved audio chunk is unsafe."));
    }
    let data = store::read_protected(path).map_err(|_| {
        ApiError::new(
            410,
            "A saved audio chunk is missing or failed authentication.",
        )
    })?;
    if data.len() as u64 != frames * 2 || hash(&data) != digest {
        return Err(ApiError::new(
            410,
            "A saved audio chunk is missing or damaged.",
        ));
    }
    Ok(data)
}
pub(super) async fn chunk(
    Path((id, sequence)): Path<(String, u64)>,
    headers: HeaderMap,
    data: Bytes,
) -> Result<Json<Value>> {
    store::run(move |db| {
    let frames = headers
        .get("x-echo-frames")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|n| *n > 0 && *n <= RATE)
        .ok_or_else(|| ApiError::bad("Chunks must contain 1–16000 frames."))?;
    let digest = headers
        .get("x-echo-sha256")
        .and_then(|v| v.to_str().ok())
        .filter(|s| s.len() == 64)
        .ok_or_else(|| ApiError::bad("A SHA256 digest is required."))?;
    if data.len() as u64 != frames * 2 || hash(&data) != digest {
        return Err(ApiError::bad("Audio hash or frame count mismatch."));
    }
        let tx = db.transaction()?;
        let mut r = owned(&tx, &headers, &id)?;
        if r["status"] == "deleted" {
            return Err(ApiError::new(410, "Recording was deleted."));
        }
        let old:Option<(u64,String,String)>=tx.query_row("SELECT frames,digest,file FROM extension_chunks WHERE recording_id=? AND sequence=?",params![id,sequence],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        if let Some((n, h, file)) = old {
            if n != frames || h != digest {
                return Err(ApiError::new(
                    409,
                    "Chunk conflicts with the saved sequence.",
                ));
            }
            let path = chunk_path(&id, &file)?;
            read_chunk(&path, n, &h)?;
            sync_audio(&path, &pcm_dir(&id)?)?;
            verify_complete_files(&tx, &r)?;
            return Ok(reply(extension_recording(r, &library(&tx)?)?));
        }
        if r["status"] != "receiving" || r["nextSequence"].as_u64() != Some(sequence) {
            return Err(ApiError::new(
                409,
                "Send the missing chunk before continuing.",
            ));
        }
        let total = r["totalFrames"].as_u64().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))? + frames;
        if total > MAX_FRAMES {
            return Err(ApiError::new(413, "Recording reached eight hours."));
        }
        let dir = pcm_dir(&id)?;
        store::mkdir(&dir)?;
        synced_directory(dir.parent().ok_or_else(|| ApiError::new(500, "Invalid recording directory."))?)?;
        synced_directory(&store::data_dir()?)?;
        let file = format!("{sequence}-{digest}.pcm");
        let path = dir.join(&file);
        if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(ApiError::new(410, "Unsafe PCM file."));
        }
        if !path.exists() || read_chunk(&path, frames, digest).is_err() {
            if path.exists() {
                fs::remove_file(&path)?;
            }
            store::write_protected(&path, &data)?;
        }
        sync_audio(&path, &dir)?;
        tx.execute(
            "INSERT INTO extension_chunks VALUES(?,?,?,?,?)",
            params![id, sequence, frames, digest, file],
        )?;
        r["nextSequence"] = json!(sequence + 1);
        r["totalFrames"] = json!(total);
        save_recording(&tx, &r)?;
        let mut meeting = store::require_meeting(&tx, r["meetingId"].as_str().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?)?;
        meeting["duration"] = json!(total as f64 / RATE as f64);
        meeting["extensionRecording"]["totalFrames"] = json!(total);
        store::save(&tx, &mut meeting)?;
        let lib = library(&tx)?;
        tx.commit()?;
        Ok(reply(extension_recording(r, &lib)?))
    }).await
}
pub(super) fn wav_header(frames: u64) -> Vec<u8> {
    let len = (frames * 2) as u32;
    let mut b = Vec::with_capacity(44);
    b.extend(b"RIFF");
    b.extend((36 + len).to_le_bytes());
    b.extend(b"WAVEfmt ");
    b.extend(16u32.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend(1u16.to_le_bytes());
    b.extend((RATE as u32).to_le_bytes());
    b.extend((RATE as u32 * 2).to_le_bytes());
    b.extend(2u16.to_le_bytes());
    b.extend(16u16.to_le_bytes());
    b.extend(b"data");
    b.extend(len.to_le_bytes());
    b
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Completion {
    pub(super) chunk_count: u64,
    pub(super) total_frames: u64,
    #[serde(default)]
    gaps: Vec<Gap>,
    interrupted: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Gap {
    at_frame: u64,
    pause_ms: u64,
}
pub(super) async fn complete(
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Completion>,
) -> Result<Json<Value>> {
    if input.total_frames == 0
        || input.total_frames > MAX_FRAMES
        || input.chunk_count > MAX_FRAMES
        || input.gaps.len() > 10000
        || input
            .gaps
            .iter()
            .any(|g| g.at_frame > input.total_frames || g.pause_ms > 8 * 3600 * 1000)
        || input.gaps.windows(2).any(|p| p[0].at_frame > p[1].at_frame)
    {
        return Err(ApiError::bad("Invalid completion manifest."));
    }
    let manifest = serde_json::to_value(&input)?;
    store::run(move |db| {
        let tx = db.transaction()?;
        let mut r = owned(&tx, &headers, &id)?;
        let lib = library(&tx)?;
        if r["status"] == "deleted" {
            return Ok(reply(extension_recording(r, &lib)?));
        }
        if r["status"] == "complete" {
            verify_complete_files(&tx, &r)?;
            if r["manifest"] != manifest {
                return Err(ApiError::new(409, "Completion manifest conflicts."));
            }
            return Ok(reply(extension_recording(r, &lib)?));
        }
        if r["nextSequence"] != input.chunk_count || r["totalFrames"] != input.total_frames {
            return Err(ApiError::new(
                409,
                "Recording has missing chunks or a different frame count.",
            ));
        }
        let rows = {
            let mut stmt=tx.prepare("SELECT sequence,frames,digest,file FROM extension_chunks WHERE recording_id=? ORDER BY sequence")?;
            let result = stmt
                .query_map([&id], |r| {
                    Ok((
                        r.get::<_, u64>(0)?,
                        r.get::<_, u64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            result
        };
        if rows.len() as u64 != input.chunk_count
            || rows.iter().enumerate().any(|(i, c)| i as u64 != c.0)
            || rows.iter().map(|c| c.1).sum::<u64>() != input.total_frames
        {
            return Err(ApiError::new(409, "Stored chunk manifest is incomplete."));
        }
        let meeting_id = r["meetingId"].as_str().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let mut meeting = store::require_meeting(&tx, meeting_id)?;
        let dir = store::data_dir()?.join("audio").join(meeting_id);
        store::mkdir(&dir)?;
        synced_directory(dir.parent().ok_or_else(|| ApiError::new(500, "Invalid recording directory."))?)?;
        let part_count = input.total_frames.div_ceil(PART_FRAMES);
        if part_count > 16 {
            return Err(ApiError::new(413, "Recording has too many parts."));
        }
        let mut tracks = Vec::new();
        let mut track_ids = Vec::new();
        let mut row_idx = 0;
        let mut remaining_chunk: Vec<u8> = vec![];
        let mut chunk_offset = 0usize;
        for part in 0..part_count {
            let frames = PART_FRAMES.min(input.total_frames - part * PART_FRAMES);
            let mut wav = wav_header(frames);
            while wav.len() < 44 + (frames * 2) as usize {
                if chunk_offset >= remaining_chunk.len() {
                    let row = &rows[row_idx];
                    remaining_chunk = read_chunk(&chunk_path(&id, &row.3)?, row.1, &row.2)?;
                    chunk_offset = 0;
                    row_idx += 1;
                }
                let n = (44 + (frames * 2) as usize - wav.len())
                    .min(remaining_chunk.len() - chunk_offset);
                wav.extend_from_slice(&remaining_chunk[chunk_offset..chunk_offset + n]);
                chunk_offset += n;
            }
            let digest = hash(&wav);
            let file = format!("extension-{part}-{digest}.wav");
            let path = dir.join(&file);
            if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
                return Err(ApiError::new(410, "Unsafe WAV file."));
            }
            if !path.exists()
                || store::read_protected(&path).map(hash).ok().as_deref() != Some(digest.as_str())
            {
                if path.exists() {
                    fs::remove_file(&path)?;
                }
                store::write_protected(&path, &wav)?;
            }
            sync_audio(&path, &dir)?;
            let track_id = Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO audio_chunks VALUES(?,?,?,?,?,?)",
                params![meeting_id, track_id, 0, file, wav.len() as u64, digest],
            )?;
            tracks.push(json!({"id":track_id,"label":format!("Recording part {} of {} (sequential)",part+1,part_count),"mimeType":"audio/wav","bytes":wav.len(),"url":format!("/api/meetings/{meeting_id}/audio/{track_id}")}));
            track_ids.push(track_id);
        }
        meeting["tracks"] = json!(tracks);
        meeting["extensionRecording"]["partTrackIds"] = json!(track_ids);
        meeting["status"] = json!(if input.interrupted {
            "interrupted"
        } else {
            "saved"
        });
        meeting.as_object_mut().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?.remove("error");
        meeting["duration"] = json!(input.total_frames as f64 / RATE as f64);
        meeting["gaps"]=json!(input.gaps.iter().map(|g|json!({"start":g.at_frame as f64/RATE as f64,"end":g.at_frame as f64/RATE as f64,"reason":format!("Recording paused for {} ms",g.pause_ms)})).collect::<Vec<_>>());
        store::validate_meeting(&meeting)?;
        store::save(&tx, &mut meeting)?;
        r["status"] = json!("complete");
        r["manifest"] = manifest;
        r["generation"] = json!(r["generation"].as_u64().unwrap_or(0) + 1);
        r.as_object_mut().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?.remove("lease");
        save_recording(&tx, &r)?;
        tx.commit()?;
        verify_complete_files(db, &r)?;
        Ok(reply(extension_recording(r, &lib)?))
    }).await
}
