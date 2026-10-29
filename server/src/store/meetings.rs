use super::*;

/// Read and decode one meeting without treating a missing record as a storage failure.
pub(crate) fn read_meeting(db: &Connection, key: &str) -> Result<Option<Value>> {
    valid_id(key)?;
    let source: Option<String> = db
        .query_row("SELECT data FROM meetings WHERE id=?", [key], |r| r.get(0))
        .optional()?;
    source
        .map(|s| serde_json::from_str(&s).map_err(ApiError::from))
        .transpose()
}
/// Return one meeting or the user-facing deleted-meeting error.
pub(crate) fn require_meeting(db: &Connection, key: &str) -> Result<Value> {
    read_meeting(db, key)?.ok_or_else(ApiError::not_found)
}
/// Update a meeting's modification timestamp and write its JSON within the caller's transaction.
pub(crate) fn save(db: &Connection, m: &mut Value) -> Result<()> {
    m["updatedAt"] = json!(now());
    db.execute(
        "UPDATE meetings SET data=? WHERE id=?",
        params![m.to_string(), m["id"].as_str()],
    )?;
    Ok(())
}
/// Decode meeting records in recency order using the supplied database connection.
pub(super) fn list_db(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT data FROM meetings")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut meetings = Vec::new();
    for row in rows {
        if let Ok(v) = serde_json::from_str::<Value>(&row?) {
            if validate_meeting(&v).is_ok() {
                meetings.push(v);
            }
        }
    }
    meetings.sort_by(|a, b| {
        b["createdAt"]
            .as_str()
            .unwrap_or_default()
            .cmp(a["createdAt"].as_str().unwrap_or_default())
    });
    Ok(meetings)
}
/// Return the saved library through serialized database access.
pub fn list_meetings() -> Result<Vec<Value>> {
    with_db(|db| list_db(db))
}
/// Validate the meeting ID and return its current persisted document if present.
pub fn get_meeting(key: &str) -> Result<Option<Value>> {
    with_db(|db| read_meeting(db, key))
}
/// Atomically reconcile only restart errors; late heartbeats cannot undo completed transcripts.
pub fn resume_browser_processing(ids: &[String]) -> Result<Vec<String>> {
    for key in ids {
        valid_id(key)?;
    }
    with_db(|db| {
        let tx = db.transaction()?;
        let mut restored = Vec::new();
        for key in ids {
            let Some(mut meeting) = read_meeting(&tx, key)? else {
                continue;
            };
            if meeting["status"] == "error" && meeting["error"] == PROCESSING_RESTART_ERROR {
                meeting["status"] = json!("processing");
                meeting
                    .as_object_mut()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                    .remove("error");
                save(&tx, &mut meeting)?;
                restored.push(key.clone());
            }
        }
        tx.commit()?;
        Ok(restored)
    })
}
/// Validate creation input and persist a meeting with empty version and audio histories.
pub fn create_meeting(input: Value) -> Result<Value> {
    object(
        &input,
        &[
            "title",
            "mode",
            "consent",
            "speechModel",
            "notesModel",
            "liveTranscription",
            "meetingUrl",
            "calendarEventId",
        ],
    )?;
    string(&input, "title", 300, true)?;
    let consent = boolean(&input, "consent", true)?
        .ok_or_else(|| ApiError::bad("A required value is missing."))?;
    boolean(&input, "liveTranscription", false)?;
    if !matches!(
        input["mode"].as_str(),
        Some("in-person" | "online" | "import")
    ) {
        return Err(ApiError::bad("Choose in-person, online, or import."));
    }
    if input["mode"] != "import" && !consent {
        return Err(ApiError::bad(
            "Confirm that everyone has agreed to the recording before you begin.",
        ));
    }
    for k in ["speechModel", "notesModel"] {
        if input.get(k).is_some() {
            string(&input, k, 200, true)?;
        }
    }
    string(&input, "calendarEventId", 500, false)?;
    if let Some(url) = string(&input, "meetingUrl", 2000, false)? {
        validate_meeting_url(url)?;
    }
    with_db(|db| {
        let settings = settings_db(db)?;
        let mut m = input;
        let timestamp = now();
        m["id"] = json!(id());
        m["status"] = json!("saved");
        m["createdAt"] = json!(timestamp);
        m["updatedAt"] = m["createdAt"].clone();
        m["duration"] = json!(0);
        for key in ["tracks", "transcripts", "notes", "moments", "gaps"] {
            m[key] = json!([]);
        }
        for key in ["speechModel", "notesModel"] {
            if m.get(key).map(Value::is_null).unwrap_or(true) {
                m[key] = settings[key].clone();
            }
        }
        if m.get("liveTranscription").is_none() {
            m["liveTranscription"] = json!(false);
        }
        db.execute(
            "INSERT INTO meetings VALUES(?,?)",
            params![m["id"].as_str(), m.to_string()],
        )?;
        Ok(m)
    })
}
/// Apply an allowlisted patch atomically while preserving consent and reference invariants.
pub fn update_meeting(key: &str, patch: Value) -> Result<Value> {
    object(
        &patch,
        &[
            "title",
            "status",
            "duration",
            "error",
            "activeTranscriptId",
            "activeNotesId",
            "liveTranscription",
            "gaps",
            "speechModel",
            "notesModel",
            "meetingUrl",
            "consent",
            "autoTranscribeSuppressed",
        ],
    )?;
    boolean(&patch, "consent", false)?;
    boolean(&patch, "autoTranscribeSuppressed", false)?;
    if let Some(url) = string(&patch, "meetingUrl", 2000, false)? {
        validate_meeting_url(url)?;
    }
    for key in ["speechModel", "notesModel"] {
        if patch.get(key).is_some() {
            string(&patch, key, 200, true)?;
        }
    }
    string(&patch, "title", 300, false)?;
    if patch.get("title").is_some() {
        string(&patch, "title", 300, true)?;
    }
    if !patch.get("error").is_some_and(Value::is_null) {
        string(&patch, "error", 4000, false)?;
    }
    number(&patch, "duration", false)?;
    boolean(&patch, "liveTranscription", false)?;
    identifier(&patch, "activeTranscriptId", false)?;
    identifier(&patch, "activeNotesId", false)?;
    if patch.get("status").is_some() {
        status(&patch["status"])?;
    }
    if patch.get("gaps").is_some() {
        validate_gaps(&patch)?;
    }
    with_db(|db| {
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        if patch["liveTranscription"] == true && m["liveTranscription"] != true {
            return Err(ApiError::new(409,"Live transcription cannot restart for this meeting. Start a new meeting to enable it."));
        }
        if matches!(patch["status"].as_str(), Some("recording" | "paused")) && m["consent"] != true
        {
            return Err(ApiError::bad("Recording requires participant consent."));
        }
        if patch["status"] == "processing" {
            crate::extensions::preempt(&tx, key)?;
        }
        for (k, v) in patch
            .as_object()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            if v.is_null() {
                m.as_object_mut()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                    .remove(k);
            } else {
                m[k] = v.clone();
            }
        }
        validate_references(&m)?;
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(m)
    })
}
/// Reject active recording work, then durably delete the meeting and its managed audio copies.
pub fn delete_meeting(key: &str) -> Result<()> {
    valid_id(key)?;
    with_db(|db| {
        let tx = db.transaction()?;
        let meeting = require_meeting(&tx, key)?;
        // Echo can restart while the extension's offscreen recorder keeps running.
        // The meeting's recovery status is advisory; only completion seals ingest.
        let receiving_extension: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM extension_recordings WHERE meeting_id=? AND json_extract(data,'$.status')='receiving')",
            [key],
            |row| row.get(0),
        )?;
        if receiving_extension {
            return Err(ApiError::new(
                409,
                "Stop the browser recording and finish transferring its audio before deleting this meeting.",
            ));
        }
        if matches!(
            meeting["status"].as_str(),
            Some("recording" | "paused" | "processing")
        ) {
            return Err(ApiError::new(
                409,
                "Stop recording or processing before deleting this meeting.",
            ));
        }
        crate::extensions::tombstone(&tx, key)?;
        tx.execute("INSERT OR IGNORE INTO deletion_jobs(id) VALUES(?)", [key])?;
        tx.commit()?;
        let removed = (|| {
            let dir = data_dir()?.join("audio").join(key);
            if dir.exists() {
                fs::remove_dir_all(dir)?;
            }
            crate::extensions::cleanup_pcm(db, key)?;
            Ok::<_, ApiError>(())
        })();
        if let Err(error) = removed {
            let mut retained = require_meeting(db, key)?;
            retained["status"] = json!("error");
            retained["error"]=json!("Deletion was interrupted. Retry deleting this meeting, or restart Echo Voice to finish the pending deletion.");
            save(db, &mut retained)?;
            return Err(error);
        }
        let tx = db.transaction()?;
        tx.execute("DELETE FROM meetings WHERE id=?", [key])?;
        tx.execute("DELETE FROM deletion_jobs WHERE id=?", [key])?;
        tx.commit()?;
        Ok(())
    })
}
/// Append a validated transcript version with the vocabulary snapshot that produced it.
pub fn add_transcript(key: &str, mut input: Value) -> Result<Value> {
    object(&input, &["model", "passages", "vocabulary", "label"])?;
    with_db(|db| {
        if input.get("vocabulary").is_none() {
            input["vocabulary"] = json!(vocabulary_db(db)?
                .into_iter()
                .filter(|v| v["enabled"] == true)
                .collect::<Vec<_>>());
        }
        validate_transcript(&input, false)?;
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        if m["transcripts"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .len()
            >= 1000
        {
            return Err(ApiError::bad(
                "This meeting reached its 1,000-version history limit.",
            ));
        }
        crate::extensions::final_succeeded(&tx, key)?;
        input["id"] = json!(id());
        input["createdAt"] = json!(now());
        m["activeTranscriptId"] = input["id"].clone();
        m["transcripts"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .push(input);
        m.as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("error");
        if !matches!(m["status"].as_str(), Some("recording" | "paused")) {
            m["status"] = json!("ready");
        }
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(m)
    })
}
/// Append manually supplied notes after validating their evidence against a transcript version.
pub fn add_notes(key: &str, input: Value) -> Result<Value> {
    add_notes_checked(key, input, None)
}
/// Generated notes may commit only against the source version explicitly reviewed for this run.
/// Manual edits can still save a historical version with its original evidence and provenance.
pub fn add_generated_notes(key: &str, input: Value, expected_transcript: &str) -> Result<Value> {
    add_notes_checked(key, input, Some(expected_transcript))
}
/// Validate note provenance and evidence, then update the active notes version atomically.
fn add_notes_checked(
    key: &str,
    mut input: Value,
    expected_transcript: Option<&str>,
) -> Result<Value> {
    validate_notes(&input, false)?;
    with_db(|db| {
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        if let Some(expected) = expected_transcript {
            if m["activeTranscriptId"].as_str() != Some(expected)
                || input["transcriptVersionId"].as_str() != Some(expected)
            {
                return Err(ApiError::new(409,"The selected transcript changed during generation. Generate notes again for the current version."));
            }
        }
        if m["notes"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .len()
            >= 1000
        {
            return Err(ApiError::bad(
                "This meeting reached its 1,000-version notes limit.",
            ));
        }
        if input["edited"] == true {
            if let Some(source) = m["notes"]
                .as_array()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                .iter()
                .find(|note| {
                    note["id"] == m["activeNotesId"]
                        && note["model"] == input["model"]
                        && note["transcriptVersionId"] == input["transcriptVersionId"]
                })
            {
                for key in ["provider", "usage"] {
                    if input.get(key).is_none() {
                        if let Some(value) = source.get(key) {
                            input[key] = value.clone();
                        }
                    }
                }
            }
        }
        if input.get("provider").is_none() {
            input["provider"] = json!("ollama");
        }
        validate_notes(&input, false)?;
        input["id"] = json!(id());
        input["createdAt"] = json!(now());
        m["activeNotesId"] = input["id"].clone();
        m["notes"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .push(input);
        validate_references(&m)?;
        m.as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("error");
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(m)
    })
}
/// Create a timestamped bookmark with an optional validated passage reference.
pub fn add_moment(key: &str, mut input: Value) -> Result<Value> {
    validate_moment(&input, false)?;
    with_db(|db| {
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        if m["moments"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .len()
            >= 10000
        {
            return Err(ApiError::bad("This meeting has too many saved moments."));
        }
        input["id"] = json!(id());
        m["moments"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .push(input);
        validate_references(&m)?;
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(m)
    })
}
/// Apply an allowlisted bookmark patch without losing its stable identity.
pub fn update_moment(key: &str, moment_id: &str, patch: Value) -> Result<Value> {
    valid_id(moment_id)?;
    object(&patch, &["time", "label", "passageId", "kind"])?;
    with_db(|db| {
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        let moment = m["moments"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .iter_mut()
            .find(|v| v["id"] == moment_id)
            .ok_or_else(|| ApiError::new(404, "This saved moment could not be found."))?;
        for (k, v) in patch
            .as_object()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
        {
            moment[k] = v.clone();
        }
        validate_moment(moment, true)?;
        validate_references(&m)?;
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(m)
    })
}
/// Remove one bookmark while preserving recording and transcript history.
pub fn delete_moment(key: &str, moment_id: &str) -> Result<Value> {
    valid_id(moment_id)?;
    with_db(|db| {
        let tx = db.transaction()?;
        let mut m = require_meeting(&tx, key)?;
        let moments = m["moments"]
            .as_array_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let before = moments.len();
        moments.retain(|m| m["id"] != moment_id);
        if before == moments.len() {
            return Err(ApiError::new(404, "This saved moment could not be found."));
        }
        save(&tx, &mut m)?;
        tx.commit()?;
        Ok(m)
    })
}
