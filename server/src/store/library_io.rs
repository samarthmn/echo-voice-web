use super::*;

/// Measure managed disk usage recursively without following symbolic links.
fn directory_bytes(dir: &Path) -> std::io::Result<u64> {
    let mut bytes = 0;
    for item in fs::read_dir(dir)? {
        let item = item?;
        let ty = item.file_type()?;
        if ty.is_dir() {
            bytes += directory_bytes(&item.path())?;
        } else if ty.is_file() {
            bytes += item.metadata()?.len();
        }
    }
    Ok(bytes)
}
/// Summarize meeting counts and library disk usage for storage settings.
pub fn storage_info() -> Result<Value> {
    init()?;
    let root = data_dir()?;
    let bytes = directory_bytes(&root)?;
    let available = fs2::available_space(&root).unwrap_or(0);
    Ok(
        json!({"path":root.to_string_lossy(),"bytes":bytes,"meetings":list_meetings()?.len(),"availableBytes":available}),
    )
}

/// Build a portable backup of meeting data and audio while excluding account credentials.
pub fn export_library() -> Result<Value> {
    with_db(|db| {
        let meetings = list_db(db)?;
        let count: i64 = db.query_row("SELECT COUNT(*) FROM meetings", [], |r| r.get(0))?;
        if count as usize != meetings.len() {
            return Err(ApiError::new(410,"A meeting record is damaged. Restore it from a backup before exporting the complete library. Healthy meetings remain available."));
        }
        let mut stmt=db.prepare("SELECT meeting_id,track_id,sequence,file,bytes,digest FROM audio_chunks ORDER BY meeting_id,track_id,sequence")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, u64>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.iter().map(|r| r.4).sum::<u64>() > MAX_BACKUP as u64 {
            return Err(ApiError::new(413,"This library is too large for a browser backup. Stop Echo Voice and copy its entire data folder to your backup disk."));
        }
        let mut audio = Vec::new();
        for (meeting, track, sequence, file, bytes, digest) in rows {
            valid_id(&meeting)?;
            valid_id(&track)?;
            if Path::new(&file).file_name().and_then(|s| s.to_str()) != Some(&file) {
                return Err(ApiError::new(500, "An audio storage reference is invalid."));
            }
            let path = data_dir()?.join("audio").join(&meeting).join(file);
            if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                return Err(ApiError::new(500, "Audio links cannot be exported."));
            }
            let data = read_protected(&path)?;
            if data.len() as u64 != bytes || format!("{:x}", Sha256::digest(&data)) != digest {
                return Err(ApiError::new(
                    410,
                    "An audio file is incomplete. Restore it before creating a backup.",
                ));
            }
            audio.push(json!({"meetingId":meeting,"trackId":track,"sequence":sequence,"data":STANDARD.encode(data)}));
        }
        let mut settings = settings_db(db)?;
        settings
            .as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("ollamaUrl");
        Ok(
            json!({"format":"echo-voice-web","version":1,"exportedAt":now(),"meetings":meetings,"vocabulary":vocabulary_db(db)?,"settings":settings,"audio":audio,"extensionRecordings":crate::extensions::backup_receipts(db)?}),
        )
    })
}
struct PreparedChunk {
    meeting: String,
    track: String,
    sequence: i64,
    filename: String,
    data: Vec<u8>,
}
/// Validate a complete backup before transactionally importing its records and audio.
pub fn import_library(input: Value) -> Result<Value> {
    object(
        &input,
        &[
            "format",
            "version",
            "exportedAt",
            "extensionRecordings",
            "meetings",
            "vocabulary",
            "settings",
            "audio",
        ],
    )?;
    if input["format"] != "echo-voice-web" || input["version"] != 1 {
        return Err(ApiError::bad("Choose an Echo Voice web backup (format echo-voice-web, version 1). Desktop library migration is not supported."));
    }
    timestamp(&input, "exportedAt")?;
    let meetings = arr(&input, "meetings", 10000)?;
    let vocabulary = arr(&input, "vocabulary", 10000)?;
    let receipts = match input.get("extensionRecordings") {
        Some(v) => crate::extensions::validate_receipts(v, meetings)?,
        None => crate::extensions::validate_receipts(&json!([]), meetings)?,
    };
    unique(meetings)?;
    unique(vocabulary)?;
    for m in meetings {
        validate_meeting(m)?;
    }
    for v in vocabulary {
        validate_vocabulary(v, true)?;
    }
    let mut settings = defaults();
    if let Some(imported) = input.get("settings") {
        object(
            imported,
            &[
                "name",
                "speechModel",
                "notesModel",
                "notesProvider",
                "chatgptModel",
                "language",
                "autoTranscribe",
                "retainAudio",
                "onboardingComplete",
            ],
        )?;
        for (k, v) in imported
            .as_object()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            settings[k] = v.clone();
        }
        validate_settings(&settings, true)?;
    }
    let mut tracks = HashMap::new();
    for m in meetings {
        for track in m["tracks"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            tracks.insert(
                format!(
                    "{}/{}",
                    m["id"]
                        .as_str()
                        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
                    track["id"]
                        .as_str()
                        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                ),
                track,
            );
        }
    }
    let mut chunks = arr(&input, "audio", 100000)?.iter().collect::<Vec<_>>();
    for chunk in &chunks {
        object(chunk, &["meetingId", "trackId", "sequence", "data"])?;
        identifier(chunk, "meetingId", true)?;
        identifier(chunk, "trackId", true)?;
        if chunk["sequence"]
            .as_i64()
            .filter(|v| (0..=1_000_000).contains(v))
            .is_none()
        {
            return Err(ApiError::bad(
                "The backup contains an invalid chunk sequence.",
            ));
        }
        string(chunk, "data", 180 * 1024 * 1024, true)?;
    }
    chunks.sort_by_key(|c| {
        (
            c["meetingId"].as_str(),
            c["trackId"].as_str(),
            c["sequence"].as_i64(),
        )
    });
    let mut sizes = HashMap::<String, u64>::new();
    let mut sequences = HashMap::<String, i64>::new();
    let mut prepared = Vec::new();
    let mut total = 0usize;
    for chunk in chunks {
        let meeting = chunk["meetingId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let track_id = chunk["trackId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let key = format!("{meeting}/{track_id}");
        let track = tracks.get(&key).ok_or_else(|| {
            ApiError::bad("The backup contains audio without a matching meeting track.")
        })?;
        let sequence = chunk["sequence"]
            .as_i64()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        if sequence != *sequences.get(&key).unwrap_or(&0) {
            return Err(ApiError::bad(
                "The backup contains missing or duplicate audio chunks.",
            ));
        }
        let data = STANDARD
            .decode(
                chunk["data"]
                    .as_str()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
            )
            .map_err(|_| ApiError::bad("The backup contains invalid audio encoding."))?;
        if data.is_empty() || data.len() > MAX_AUDIO {
            return Err(ApiError::bad(
                "The backup contains an invalid audio chunk size.",
            ));
        }
        if sequence == 0 {
            audio_header(
                &data,
                track["mimeType"]
                    .as_str()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
            )?;
        }
        total += data.len();
        if total > MAX_BACKUP {
            return Err(ApiError::new(
                413,
                "This backup exceeds the 180 MB audio import limit.",
            ));
        }
        *sizes.entry(key.clone()).or_default() += data.len() as u64;
        sequences.insert(key, sequence + 1);
        prepared.push(PreparedChunk {
            meeting: meeting.into(),
            track: track_id.into(),
            sequence,
            filename: format!("{track_id}-{sequence}-{}.chunk", id()),
            data,
        });
    }
    for (key, track) in &tracks {
        if sizes.get(key).copied() != track["bytes"].as_u64() {
            return Err(ApiError::bad(
                "The backup is missing audio or contains mismatched audio sizes.",
            ));
        }
    }
    init()?;
    let staging = data_dir()?.join(format!(".import-{}", id()));
    mkdir(&staging)?;
    let mut installed = Vec::<PathBuf>::new();
    let outcome = (|| {
        for chunk in &prepared {
            let dir = staging.join(&chunk.meeting);
            mkdir(&dir)?;
            write_protected_for(
                &dir.join(&chunk.filename),
                &data_dir()?
                    .join("audio")
                    .join(&chunk.meeting)
                    .join(&chunk.filename),
                &chunk.data,
            )?;
        }
        with_db(|db| {
            let tx = db.transaction()?;
            let count: i64 = tx.query_row(
                "SELECT (SELECT COUNT(*) FROM meetings)+(SELECT COUNT(*) FROM vocabulary)",
                [],
                |r| r.get(0),
            )?;
            if count != 0 {
                return Err(ApiError::new(409,"Import requires an empty library and vocabulary. Export your current workspace, then use a separate empty data folder."));
            }
            crate::extensions::restore_receipts(&tx, &receipts)?;
            for source in meetings {
                let mut m = source.clone();
                let key = m["id"]
                    .as_str()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                    .to_string();
                for t in m["tracks"]
                    .as_array_mut()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                {
                    t["url"] = json!(audio_url(
                        &key,
                        t["id"]
                            .as_str()
                            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                    ));
                }
                if matches!(
                    m["status"].as_str(),
                    Some("recording" | "paused" | "processing")
                ) {
                    m["status"] = json!("interrupted");
                    m["error"]=json!("This backup contains an unfinished recording or processing run. Review the saved audio and retry processing.");
                }
                tx.execute(
                    "INSERT INTO meetings VALUES(?,?)",
                    params![key, m.to_string()],
                )?;
                let from = staging.join(&key);
                if from.exists() {
                    let dest = data_dir()?.join("audio").join(&key);
                    if dest.exists() {
                        return Err(ApiError::new(409,"A leftover audio folder conflicts with this backup. Use an empty data folder."));
                    }
                    fs::rename(from, &dest)?;
                    installed.push(dest);
                }
            }
            for chunk in &prepared {
                tx.execute(
                    "INSERT INTO audio_chunks VALUES(?,?,?,?,?,?)",
                    params![
                        chunk.meeting,
                        chunk.track,
                        chunk.sequence,
                        chunk.filename,
                        chunk.data.len() as i64,
                        format!("{:x}", Sha256::digest(&chunk.data))
                    ],
                )?;
            }
            for entry in vocabulary {
                tx.execute(
                    "INSERT INTO vocabulary VALUES(?,?)",
                    params![entry["id"].as_str(), entry.to_string()],
                )?;
            }
            if input.get("settings").is_some() {
                tx.execute("INSERT INTO preferences VALUES('settings',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[settings.to_string()])?;
            }
            tx.commit()?;
            Ok(json!({"meetings":meetings.len(),"vocabulary":vocabulary.len()}))
        })
    })();
    if outcome.is_err() {
        for dir in installed {
            let _ = fs::remove_dir_all(dir);
        }
    }
    let _ = fs::remove_dir_all(staging);
    outcome
}
/// Format transcript timestamps for subtitle or readable text exports.
fn stamp(seconds: f64, srt: bool) -> String {
    let whole = seconds.floor() as u64;
    let base = format!(
        "{:02}:{:02}:{:02}",
        whole / 3600,
        (whole / 60) % 60,
        whole % 60
    );
    if srt {
        format!(
            "{base},{:03}",
            ((seconds - seconds.floor()) * 1000.0).round().min(999.0) as u64
        )
    } else {
        base
    }
}
/// Read a string from validated meeting JSON for export formatting.
fn strv<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}
/// Render a saved meeting as a supported document or subtitle download.
pub fn export_meeting(key: &str, format: &str) -> Result<(String, &'static str, String)> {
    let m = get_meeting(key)?.ok_or_else(ApiError::not_found)?;
    let name = m["title"]
        .as_str()
        .unwrap_or("meeting")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .take(80)
        .collect::<String>();
    let transcript = m["transcripts"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        .iter()
        .find(|v| v["id"] == m["activeTranscriptId"]);
    let notes = m["notes"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        .iter()
        .find(|v| v["id"] == m["activeNotesId"]);
    let empty = Vec::new();
    let passages = transcript
        .and_then(|t| t["passages"].as_array())
        .unwrap_or(&empty);
    if format == "json" {
        return Ok((
            serde_json::to_string_pretty(&m)?,
            "application/json",
            format!("{name}.json"),
        ));
    }
    if format == "srt" {
        let body = passages
            .iter()
            .enumerate()
            .map(|(i, p)| {
                format!(
                    "{}\n{} --> {}\n{}: {}\n",
                    i + 1,
                    stamp(p["start"].as_f64().unwrap_or(0.0), true),
                    stamp(p["end"].as_f64().unwrap_or(0.0), true),
                    strv(p, "speaker"),
                    strv(p, "text")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return Ok((body, "application/x-subrip", format!("{name}.srt")));
    }
    if format != "txt" && format != "md" {
        return Err(ApiError::bad("Choose json, txt, srt, or md export format."));
    }
    let mut body = format!(
        "# {}\n\nRecorded: {}\nMode: {}\nDuration: {}\nSpeech model: {}\nTranscript version: {}\n",
        strv(&m, "title"),
        strv(&m, "createdAt"),
        strv(&m, "mode"),
        stamp(m["duration"].as_f64().unwrap_or(0.0), false),
        transcript
            .map(|t| strv(t, "model"))
            .unwrap_or("No transcript"),
        transcript.map(|t| strv(t, "id")).unwrap_or("None")
    );
    if let Some(notes) = notes {
        body.push_str(&format!(
            "\nNotes provider: {}\nNotes model: {}\nNotes source transcript: {}\n",
            notes["provider"].as_str().unwrap_or("ollama"),
            strv(notes, "model"),
            strv(notes, "transcriptVersionId")
        ));
        if notes["transcriptVersionId"] != m["activeTranscriptId"] {
            body.push_str("These notes refer to an earlier transcript version.\n");
        }
        for (group, title) in [
            ("summary", "Summary"),
            ("decisions", "Decisions"),
            ("actions", "Action items"),
        ] {
            body.push_str(&format!("\n## {title}\n"));
            for n in notes[group]
                .as_array()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            {
                body.push_str(&format!(
                    "- {}{}{}{} [Evidence: {}]\n",
                    if n["done"] == true { "[x] " } else { "" },
                    strv(n, "text"),
                    n.get("owner")
                        .and_then(Value::as_str)
                        .map(|s| format!(" — {s}"))
                        .unwrap_or_default(),
                    n.get("dueDate")
                        .and_then(Value::as_str)
                        .map(|s| format!(" (due {s})"))
                        .unwrap_or_default(),
                    n["passageIds"]
                        .as_array()
                        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
        }
    }
    body.push_str("\n## Transcript\n");
    for p in passages {
        body.push_str(&format!(
            "\n[{}–{}] {}: {} [{}]\n",
            stamp(p["start"].as_f64().unwrap_or(0.0), false),
            stamp(p["end"].as_f64().unwrap_or(0.0), false),
            strv(p, "speaker"),
            strv(p, "text"),
            strv(p, "id")
        ));
    }
    if !m["moments"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        .is_empty()
    {
        body.push_str("\n## Saved moments\n");
        for moment in m["moments"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            body.push_str(&format!(
                "- [{}] {}: {} [{}]\n",
                stamp(moment["time"].as_f64().unwrap_or(0.0), false),
                strv(moment, "kind"),
                strv(moment, "label"),
                strv(moment, "passageId")
            ));
        }
    }
    if !m["gaps"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        .is_empty()
    {
        body.push_str("\n## Recording gaps\n");
        for gap in m["gaps"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            body.push_str(&format!(
                "- {}–{}: {}\n",
                stamp(gap["start"].as_f64().unwrap_or(0.0), false),
                stamp(gap["end"].as_f64().unwrap_or(0.0), false),
                strv(gap, "reason")
            ));
        }
    }
    if !m["tracks"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        .is_empty()
    {
        body.push_str("\n## Audio tracks\n");
        for t in m["tracks"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            body.push_str(&format!(
                "- {} ({}, {} bytes); download separately from Echo Voice.\n",
                strv(t, "label"),
                strv(t, "mimeType"),
                t["bytes"]
            ));
        }
    }
    Ok((
        body,
        if format == "md" {
            "text/markdown"
        } else {
            "text/plain"
        },
        format!("{name}.{format}"),
    ))
}
