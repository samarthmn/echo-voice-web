use super::*;

pub(super) async fn live_preview(
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    store::run(move |db| {
        let r = owned(db, &headers, &id)?;
        if r["status"] == "deleted" {
            return Err(ApiError::new(410, "Recording was deleted."));
        }
        let meeting = store::require_meeting(
            db,
            r["meetingId"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
        )?;
        Ok(reply(live_snapshot(&r, &meeting, &library(db)?, seconds())))
    })
    .await
}
pub(super) fn live_snapshot(r: &Value, meeting: &Value, lib: &str, now: i64) -> Value {
    let total = r["totalFrames"].as_u64().unwrap_or(0);
    let finalized = r["status"] == "complete"
        && meeting["transcripts"]
            .as_array()
            .is_some_and(|items| !items.is_empty());
    let through = r["draft"]["throughFrame"]
        .as_u64()
        .unwrap_or(if finalized { total } else { 0 });
    let fresh = r["liveStatus"]["updatedAt"]
        .as_i64()
        .is_some_and(|at| at <= now && now - at < 15)
        && r["liveStatus"]["generation"] == r["generation"];
    let status = if r["liveTranscription"] != true {
        "disabled"
    } else if meeting["status"] == "processing" {
        "finalizing"
    } else if finalized {
        "complete"
    } else if r["status"] == "complete" {
        "final-transcript-needed"
    } else if fresh {
        r["liveStatus"]["status"]
            .as_str()
            .unwrap_or("paused-open-echo")
    } else {
        "paused-open-echo"
    };
    // Walk backwards until the bounded tail is full; do not assemble an hours-long transcript.
    let mut tail = Vec::new();
    let mut remaining = 600;
    if let Some(words) = r["draft"]["words"].as_array() {
        for word in words.iter().rev() {
            let Some(text) = word["text"].as_str() else {
                continue;
            };
            if remaining == 0 {
                break;
            }
            let fragment: String = text
                .chars()
                .rev()
                .take(remaining)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            remaining = remaining.saturating_sub(fragment.chars().count() + 1);
            tail.push(fragment);
        }
    }
    tail.reverse();
    json!({"recordingId":r["recordingId"],"meetingId":r["meetingId"],"libraryId":lib,"status":status,
        "throughFrame":through,"committedThroughFrame":r["draft"]["committedThroughFrame"].as_u64().unwrap_or(if finalized { total } else { 0 }),
        "totalFrames":total,"backlogSeconds":total.saturating_sub(through) as f64 / RATE as f64,
        "preview":tail.join(" "),"provisional":r["draft"]["words"].as_array().is_some_and(|words| words.iter().any(|word| word["provisional"] == true))})
}
/// A status heartbeat is advisory; it never changes draft text or acquires a processing lease.
pub(super) async fn live_status(
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
    store::run(move |db| {
        fields(&v, &["ownerId", "generation", "status"])?;
        text(&v, "ownerId", 100)?;
        let status = text(&v, "status", 32)?;
        if !matches!(
            status,
            "live"
                | "catching-up"
                | "waiting-audio"
                | "model-missing"
                | "processing-busy"
                | "paused-open-echo"
        ) || v["generation"].as_u64().is_none()
        {
            return Err(ApiError::bad("Invalid live status."));
        }
        let mut r = recording(db, &id)?;
        let active = r["lease"]["expiresAt"]
            .as_i64()
            .is_some_and(|at| at > seconds());
        if r["status"] != "receiving"
            || r["liveTranscription"] != true
            || r["generation"] != v["generation"]
            || (active
                && (r["lease"]["ownerId"] != v["ownerId"]
                    || r["lease"]["generation"] != v["generation"]))
            || (!active && matches!(status, "live" | "catching-up" | "waiting-audio"))
        {
            return Err(ApiError::new(
                409,
                "Live status owner was replaced or is unavailable.",
            ));
        }
        r["liveStatus"] =
            json!({"status":status,"generation":v["generation"],"updatedAt":seconds()});
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"saved"})))
    })
    .await
}
/// Preserve prior temporal ownership; newly owned overlapping words may sort before old words.
pub(super) fn committed_words_match(old: &Value, submitted: &[Value]) -> bool {
    let Some(old_words) = old["words"].as_array() else {
        return true;
    };
    let previous = old["committedThroughFrame"].as_u64().unwrap_or(0);
    let stable: Vec<&Value> = old_words
        .iter()
        .filter(|word| word["provisional"] == false)
        .collect();
    let prior_owned: Vec<&Value> = submitted
        .iter()
        .filter(|word| {
            word["startFrame"]
                .as_u64()
                .zip(word["endFrame"].as_u64())
                .is_some_and(|(start, end)| start.saturating_add(end) <= 2 * previous)
        })
        .collect();
    stable == prior_owned
}
pub(super) async fn draft(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
    fields(
        &v,
        &[
            "ownerId",
            "generation",
            "throughFrame",
            "committedThroughFrame",
            "words",
            "language",
            "modelRevision",
        ],
    )?;
    text(&v, "ownerId", 100)?;
    text(&v, "language", 100)?;
    text(&v, "modelRevision", 200)?;
    let through = v["throughFrame"]
        .as_u64()
        .filter(|n| *n <= MAX_FRAMES)
        .ok_or_else(|| ApiError::bad("Invalid draft cursor."))?;
    let committed = v["committedThroughFrame"]
        .as_u64()
        .filter(|n| *n <= through)
        .ok_or_else(|| ApiError::bad("Invalid committed cursor."))?;
    let words = v["words"]
        .as_array()
        .filter(|w| w.len() <= 100000)
        .ok_or_else(|| ApiError::bad("Draft is too large."))?;
    let mut previous = 0;
    for word in words {
        fields(word, &["text", "startFrame", "endFrame", "provisional"])?;
        text(word, "text", 1000)?;
        let start = word["startFrame"]
            .as_u64()
            .filter(|n| *n >= previous)
            .ok_or_else(|| ApiError::bad("Invalid word start."))?;
        let end = word["endFrame"]
            .as_u64()
            .filter(|n| *n >= start && *n <= through)
            .ok_or_else(|| ApiError::bad("Invalid word end."))?;
        if !word["provisional"].is_boolean()
            || word["provisional"] != json!(start + end > 2 * committed)
        {
            return Err(ApiError::bad("Invalid provisional word boundary."));
        }
        previous = start;
    }
    store::run(move |db| {
        let mut r = recording(db, &id)?;
        if r["status"] != "receiving"
            || r["lease"]["ownerId"] != v["ownerId"]
            || r["lease"]["generation"] != v["generation"]
            || r["lease"]["expiresAt"]
                .as_i64()
                .is_none_or(|n| n <= seconds())
        {
            return Err(ApiError::new(
                409,
                "Processing lease expired or was replaced.",
            ));
        }
        if through
            > r["totalFrames"]
                .as_u64()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            || through < r["draft"]["throughFrame"].as_u64().unwrap_or(0)
            || committed < r["draft"]["committedThroughFrame"].as_u64().unwrap_or(0)
        {
            return Err(ApiError::new(
                409,
                "Draft cursor is outside saved audio or moved backwards.",
            ));
        }
        if !committed_words_match(
            &r["draft"],
            v["words"]
                .as_array()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
        ) {
            return Err(ApiError::new(
                409,
                "Committed live words cannot be replaced.",
            ));
        }
        let mut saved = v;
        saved
            .as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("ownerId");
        saved
            .as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("generation");
        r["draft"] = saved;
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"saved"})))
    })
    .await
}
