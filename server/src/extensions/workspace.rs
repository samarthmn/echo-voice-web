use super::*;

pub(super) async fn recordings() -> Result<Json<Value>> {
    store::run(move |db| {
        let lib = library(db)?;
        let mut stmt = db.prepare("SELECT data FROM extension_recordings")?;
        let values = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|r| public_recording(serde_json::from_str(&r)?, &lib))
            .collect::<Result<Vec<_>>>()?;
        Ok(reply(json!({"libraryId":lib,"recordings":values})))
    })
    .await
}
pub(super) async fn control(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
        fields(&v, &["action", "commandId"])?;
        let action = text(&v, "action", 10)?;
        if !matches!(action, "pause" | "resume" | "stop") {
            return Err(ApiError::bad("Unsupported recording control."));
        }
        let command = text(&v, "commandId", 36)?;
        uid(command)?;
        let mut r = recording(db, &id)?;
        if r["status"] != "receiving" {
            return Err(ApiError::new(409, "Recording is no longer receiving."));
        }
        if let Some(old) = r["controlHistory"].get(command) {
            if old != action {
                return Err(ApiError::new(409, "Control command conflicts."));
            }
        } else {
            if r["controls"]
                .as_array()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                .len()
                >= 100
                || r["controlHistory"]
                    .as_object()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                    .len()
                    >= 10000
            {
                return Err(ApiError::new(429, "Too many controls."));
            }
            r["controlHistory"][command] = json!(action);
            r["controls"]
                .as_array_mut()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                .push(json!({"commandId":command,"action":action}));
        }
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"queued"})))
    })
    .await
}
pub(super) async fn ack(
    Path((id, command)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    uid(&command)?;
    store::run(move |db| {
        let mut r = owned(db, &headers, &id)?;
        r["controls"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .retain(|c| c["commandId"] != command);
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"acknowledged"})))
    })
    .await
}
pub(super) async fn lease(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
    store::run(move |db| {
    fields(&v, &["ownerId"])?;
    let owner = text(&v, "ownerId", 100)?;
        let mut r = recording(db, &id)?;
        let meeting = store::require_meeting(db, r["meetingId"].as_str().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?)?;
        if r["status"] != "receiving"
            || r["liveTranscription"] != true
            || meeting["status"] == "processing"
        {
            return Err(ApiError::new(409, "Live processing is unavailable."));
        }
        let active = r["lease"]["expiresAt"]
            .as_i64()
            .is_some_and(|e| e > seconds());
        if active && r["lease"]["ownerId"] != owner {
            return Err(ApiError::new(
                409,
                "Another Echo tab is processing this recording.",
            ));
        }
        let generation = r["generation"].as_u64().unwrap_or(0) + if active { 0 } else { 1 };
        let expires = seconds() + 60;
        r["generation"] = json!(generation);
        r["lease"] = json!({"ownerId":owner,"generation":generation,"expiresAt":expires});
        save_recording(db, &r)?;
        Ok(reply(
            json!({"generation":generation,"expiresAt":expires,"totalFrames":r["totalFrames"],"draft":r.get("draft").cloned().unwrap_or(Value::Null)}),
        ))
    }).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PcmQuery {
    start_frame: u64,
    frame_count: u64,
}
pub(super) async fn pcm(Path(id): Path<String>, Query(q): Query<PcmQuery>) -> Result<Response> {
    if q.frame_count == 0 || q.frame_count > RATE * 20 {
        return Err(ApiError::bad("Request at most 20 seconds of PCM."));
    }
    let data = store::run(move |db| {
        let r = recording(db, &id)?;
        if r["status"] == "deleted" {
            return Err(ApiError::new(410, "Recording was deleted."));
        }
        let total_frames = r["totalFrames"].as_u64().ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let end = q
            .start_frame
            .checked_add(q.frame_count)
            .filter(|n| *n <= total_frames)
            .ok_or_else(|| ApiError::bad("PCM range exceeds saved audio."))?;
        let mut stmt=db.prepare("SELECT frames,digest,file FROM extension_chunks WHERE recording_id=? ORDER BY sequence")?;
        let rows = stmt
            .query_map([id.as_str()], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut cursor = 0;
        let mut out = Vec::with_capacity(q.frame_count as usize * 2);
        for (frames, digest, file) in rows {
            let part_end = cursor + frames;
            if part_end > q.start_frame && cursor < end {
                let data = read_chunk(&chunk_path(&id, &file)?, frames, &digest)?;
                let a = q.start_frame.saturating_sub(cursor) as usize * 2;
                let b = (end.min(part_end) - cursor) as usize * 2;
                out.extend_from_slice(&data[a..b]);
            }
            cursor = part_end;
            if cursor >= end {
                break;
            }
        }
        if out.len() != q.frame_count as usize * 2 {
            return Err(ApiError::new(410, "PCM data is incomplete."));
        }
        Ok(out)
    }).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        data,
    )
        .into_response())
}
/// Play sequential WAV parts as one virtual WAV, without assembling the recording in memory.
pub(super) async fn meeting_audio(
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Response> {
    let (frames, sources) = store::blocking(move || {
        let meeting = store::get_meeting(&id)?.ok_or_else(ApiError::not_found)?;
        let metadata = meeting
            .get("extensionRecording")
            .ok_or_else(ApiError::not_found)?;
        validate_metadata(metadata)?;
        let frames = metadata["totalFrames"]
            .as_u64()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let mut sources = Vec::new();
        for track in metadata["partTrackIds"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            let (_, parts) = store::get_audio_parts(
                &id,
                track
                    .as_str()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
            )?;
            for (index, part) in parts.into_iter().enumerate() {
                let skip = if index == 0 { 44 } else { 0 };
                if part.bytes < skip {
                    return Err(ApiError::new(410, "Sequential WAV part is incomplete."));
                }
                sources.push((part.path, skip, part.bytes - skip));
            }
        }
        if sources.iter().map(|s| s.2).sum::<u64>() != frames * 2 {
            return Err(ApiError::new(
                410,
                "Recording has incomplete sequential parts.",
            ));
        }
        Ok((frames, sources))
    })
    .await?;
    let total = 44 + frames * 2;
    let header_bytes = wav_header(frames);
    let (start, end, partial) = match audio_range(
        headers.get(header::RANGE).and_then(|h| h.to_str().ok()),
        total,
    ) {
        Ok(v) => v,
        Err(error) => {
            let mut response = reply_error(error);
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{total}"))
                    .map_err(|_| ApiError::new(500, "Invalid audio range."))?,
            );
            return Ok(response);
        }
    };
    let stream = async_stream::stream! {
        if start < 44 { yield Ok::<Vec<u8>,std::io::Error>(header_bytes[start as usize..(end+1).min(44) as usize].to_vec()); }
        let mut offset = 44;
        for (path, skip, size) in sources {
            let part_start = offset; let part_end = offset + size; offset = part_end;
            if part_end <= start || part_start > end { continue; }
            let from = start.saturating_sub(part_start); let until = (end+1).min(part_end)-part_start;
            let mut cursor = from;
            while cursor < until {
                let length = (until-cursor).min(65536) as usize;
                match store::protected_range(path.clone(), skip+cursor, length).await {
                    Ok(bytes)=>{cursor += bytes.len() as u64; yield Ok(bytes);},
                    Err(error)=>{ yield Err(error); return; }
                }
            }
        }
    };
    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, "audio/wav")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .header(header::CACHE_CONTROL, "no-store");
    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    if query.get("download").is_some_and(|s| s == "1") {
        builder = builder.header(
            header::CONTENT_DISPOSITION,
            "attachment; filename=\"recording.wav\"",
        );
    }
    builder
        .body(axum::body::Body::from_stream(stream))
        .map_err(|_| ApiError::new(500, "Audio could not be opened."))
}
pub(super) fn audio_range(value: Option<&str>, size: u64) -> Result<(u64, u64, bool)> {
    let Some(raw) = value else {
        return Ok((0, size - 1, false));
    };
    let (a, b) = raw
        .strip_prefix("bytes=")
        .and_then(|s| s.split_once('-'))
        .filter(|(a, b)| !a.contains(',') && !b.contains(','))
        .ok_or_else(|| ApiError::new(416, "Invalid audio range."))?;
    let (start, end) = if a.is_empty() {
        let n = b
            .parse::<u64>()
            .ok()
            .filter(|n| *n > 0)
            .ok_or_else(|| ApiError::new(416, "Invalid suffix."))?;
        (size.saturating_sub(n), size - 1)
    } else {
        let a = a
            .parse::<u64>()
            .map_err(|_| ApiError::new(416, "Invalid audio range."))?;
        let b = if b.is_empty() {
            size - 1
        } else {
            b.parse::<u64>()
                .map_err(|_| ApiError::new(416, "Invalid audio range."))?
                .min(size - 1)
        };
        (a, b)
    };
    if start >= size || end < start {
        return Err(ApiError::new(416, "Audio range is outside recording."));
    }
    Ok((start, end, true))
}
