use super::*;

/// Reject identifiers that could escape managed paths or exceed supported lengths.
pub(crate) fn valid_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(ApiError::bad("An identifier is invalid."));
    }
    Ok(())
}
/// Require a JSON object whose keys belong to the endpoint's explicit allowlist.
pub(super) fn object<'a>(
    v: &'a Value,
    allowed: &[&str],
) -> Result<&'a serde_json::Map<String, Value>> {
    let obj = v
        .as_object()
        .ok_or_else(|| ApiError::bad("Expected a JSON object."))?;
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ApiError::bad("The request contains unsupported fields."));
    }
    Ok(obj)
}
/// Validate optional or required text fields without silently coercing JSON types.
pub(super) fn string<'a>(
    v: &'a Value,
    key: &str,
    max: usize,
    required: bool,
) -> Result<Option<&'a str>> {
    match v.get(key) {
        None if !required => Ok(None),
        Some(Value::String(s)) if s.len() <= max && (!required || !s.trim().is_empty()) => {
            Ok(Some(s))
        }
        _ => Err(ApiError::bad(format!(
            "'{key}' must be {}text with at most {max} characters.",
            if required { "nonempty " } else { "" }
        ))),
    }
}
/// Require finite nonnegative numeric values when a field is present.
pub(super) fn number(v: &Value, key: &str, required: bool) -> Result<Option<f64>> {
    match v.get(key) {
        None if !required => Ok(None),
        Some(n)
            if n.as_f64()
                .map(|n| n.is_finite() && (0.0..=31536000.0).contains(&n))
                .unwrap_or(false) =>
        {
            Ok(n.as_f64())
        }
        _ => Err(ApiError::bad(format!(
            "'{key}' must be a nonnegative duration in seconds."
        ))),
    }
}
/// Validate a boolean field, enforcing presence when requested.
pub(super) fn boolean(v: &Value, key: &str, required: bool) -> Result<Option<bool>> {
    match v.get(key) {
        None if !required => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        _ => Err(ApiError::bad(format!("'{key}' must be true or false."))),
    }
}
/// Validate a bounded array before iterating user-supplied records.
pub(super) fn arr<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>> {
    let a = v
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::bad(format!("'{key}' must be a list.")))?;
    if a.len() > max {
        return Err(ApiError::bad(format!(
            "'{key}' exceeds the {max} item limit."
        )));
    }
    Ok(a)
}
/// Check an optional entity reference with the same rules as stored identifiers.
pub(super) fn identifier(v: &Value, key: &str, required: bool) -> Result<()> {
    if let Some(id) = string(v, key, 100, required)? {
        valid_id(id)?;
    }
    Ok(())
}
/// Require a parseable RFC 3339 timestamp for portable records.
pub(super) fn timestamp(v: &Value, key: &str) -> Result<()> {
    let s =
        string(v, key, 100, true)?.ok_or_else(|| ApiError::bad("A required value is missing."))?;
    chrono::DateTime::parse_from_rfc3339(s)
        .map_err(|_| ApiError::bad(format!("'{key}' must be an ISO date.")))?;
    Ok(())
}
/// Reject duplicate entity IDs within a version or collection.
pub(super) fn unique(items: &[Value]) -> Result<()> {
    let mut ids = HashSet::new();
    for item in items {
        identifier(item, "id", true)?;
        if !ids.insert(
            item["id"]
                .as_str()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?,
        ) {
            return Err(ApiError::bad("A list contains duplicate identifiers."));
        }
    }
    Ok(())
}
/// Validate a term, its aliases, enabled flag, and optional persisted identity.
pub(super) fn validate_vocabulary(v: &Value, with_id: bool) -> Result<()> {
    object(
        v,
        if with_id {
            &["id", "term", "aliases", "enabled"]
        } else {
            &["term", "aliases", "enabled"]
        },
    )?;
    if with_id {
        identifier(v, "id", true)?;
    }
    string(v, "term", 200, true)?;
    boolean(v, "enabled", true)?;
    for alias in arr(v, "aliases", 50)? {
        if alias
            .as_str()
            .map(|s| !s.trim().is_empty() && s.len() <= 200)
            != Some(true)
        {
            return Err(ApiError::bad(
                "Vocabulary aliases must be nonempty text under 200 characters.",
            ));
        }
    }
    Ok(())
}
/// Check transcript text, speaker, timestamps, and passage identity.
fn validate_passage(v: &Value) -> Result<()> {
    object(v, &["id", "start", "end", "text", "speaker", "uncertain"])?;
    identifier(v, "id", true)?;
    let start =
        number(v, "start", true)?.ok_or_else(|| ApiError::bad("A required value is missing."))?;
    let end =
        number(v, "end", true)?.ok_or_else(|| ApiError::bad("A required value is missing."))?;
    if end < start {
        return Err(ApiError::bad("Passage end must be after its start."));
    }
    string(v, "text", 200_000, false)?;
    if v.get("text").and_then(Value::as_str).is_none() {
        return Err(ApiError::bad("A passage requires text."));
    }
    string(v, "speaker", 200, false)?;
    if v.get("speaker").and_then(Value::as_str).is_none() {
        return Err(ApiError::bad("A passage requires a speaker label."));
    }
    boolean(v, "uncertain", false)?;
    Ok(())
}
/// Validate a transcript version and its bounded, unique passage collection.
pub(super) fn validate_transcript(v: &Value, with_id: bool) -> Result<()> {
    object(
        v,
        if with_id {
            &[
                "id",
                "createdAt",
                "model",
                "passages",
                "vocabulary",
                "label",
            ]
        } else {
            &["model", "passages", "vocabulary", "label"]
        },
    )?;
    if with_id {
        identifier(v, "id", true)?;
        timestamp(v, "createdAt")?;
    }
    string(v, "model", 200, true)?;
    string(v, "label", 200, false)?;
    let passages = arr(v, "passages", 100_000)?;
    unique(passages)?;
    for p in passages {
        validate_passage(p)?;
    }
    for entry in arr(v, "vocabulary", 10000)? {
        validate_vocabulary(entry, true)?;
    }
    Ok(())
}
/// Accept only providers whose provenance the workspace understands.
pub(super) fn validate_notes_provider(provider: &str) -> Result<()> {
    if !matches!(provider, "ollama" | "chatgpt") {
        return Err(ApiError::bad(
            "Choose Ollama or ChatGPT as the notes provider.",
        ));
    }
    Ok(())
}
/// Check optional token counts without accepting invented or malformed usage metadata.
pub(super) fn validate_note_usage(usage: &Value) -> Result<()> {
    let values = object(usage, &["inputTokens", "outputTokens", "cachedInputTokens"])?;
    for value in values.values() {
        if value
            .as_u64()
            .filter(|value| *value <= 9_007_199_254_740_991)
            .is_none()
        {
            return Err(ApiError::bad(
                "Notes usage must contain known nonnegative integer token counts.",
            ));
        }
    }
    if let (Some(input), Some(cached)) = (
        usage["inputTokens"].as_u64(),
        usage["cachedInputTokens"].as_u64(),
    ) {
        if cached > input {
            return Err(ApiError::bad(
                "Cached input tokens cannot exceed total input tokens.",
            ));
        }
    }
    Ok(())
}
/// Validate evidence-linked summary, decision, and action items before saving.
pub(super) fn validate_notes(v: &Value, with_id: bool) -> Result<()> {
    object(
        v,
        if with_id {
            &[
                "id",
                "createdAt",
                "model",
                "transcriptVersionId",
                "summary",
                "decisions",
                "actions",
                "edited",
                "provider",
                "usage",
            ]
        } else {
            &[
                "model",
                "transcriptVersionId",
                "summary",
                "decisions",
                "actions",
                "edited",
                "provider",
                "usage",
            ]
        },
    )?;
    if with_id {
        identifier(v, "id", true)?;
        timestamp(v, "createdAt")?;
    }
    string(v, "model", 200, true)?;
    identifier(v, "transcriptVersionId", true)?;
    boolean(v, "edited", false)?;
    if let Some(provider) = string(v, "provider", 20, false)? {
        validate_notes_provider(provider)?;
    }
    if let Some(usage) = v.get("usage") {
        validate_note_usage(usage)?;
    }
    for group in ["summary", "decisions", "actions"] {
        let items = arr(v, group, 10000)?;
        unique(items)?;
        for n in items {
            object(n, &["id", "text", "passageIds", "owner", "dueDate", "done"])?;
            string(n, "text", 200_000, true)?;
            string(n, "owner", 200, false)?;
            string(n, "dueDate", 100, false)?;
            boolean(n, "done", false)?;
            for p in arr(n, "passageIds", 10000)? {
                valid_id(
                    p.as_str()
                        .ok_or_else(|| ApiError::bad("Invalid evidence reference."))?,
                )?;
            }
        }
    }
    Ok(())
}
/// Validate mute intervals so they remain ordered within the recording timeline.
pub(super) fn validate_gaps(v: &Value) -> Result<()> {
    for gap in arr(v, "gaps", 10000)? {
        object(gap, &["start", "end", "reason"])?;
        if number(gap, "end", true)?.ok_or_else(|| ApiError::bad("A required value is missing."))?
            < number(gap, "start", true)?
                .ok_or_else(|| ApiError::bad("A required value is missing."))?
        {
            return Err(ApiError::bad("Gap end must be after its start."));
        }
        string(gap, "reason", 1000, true)?;
    }
    Ok(())
}
/// Validate a bookmark label, timestamp, and optional transcript passage reference.
pub(super) fn validate_moment(v: &Value, with_id: bool) -> Result<()> {
    object(
        v,
        if with_id {
            &["id", "time", "label", "passageId", "kind"]
        } else {
            &["time", "label", "passageId", "kind"]
        },
    )?;
    if with_id {
        identifier(v, "id", true)?;
    }
    number(v, "time", true)?;
    string(v, "label", 1000, false)?;
    if v.get("label").and_then(Value::as_str).is_none() {
        return Err(ApiError::bad("A saved moment requires a label."));
    }
    identifier(v, "passageId", false)?;
    if !matches!(v["kind"].as_str(), Some("bookmark" | "highlight")) {
        return Err(ApiError::bad("Choose bookmark or highlight."));
    }
    Ok(())
}
/// Reject meeting states outside the supported recording and processing lifecycle.
pub(super) fn status(v: &Value) -> Result<()> {
    if !matches!(
        v.as_str(),
        Some("recording" | "paused" | "saved" | "processing" | "ready" | "interrupted" | "error")
    ) {
        return Err(ApiError::bad("Invalid meeting status."));
    }
    Ok(())
}
/// Ensure active versions, evidence links, and bookmarks reference entities in this meeting.
pub(super) fn validate_references(m: &Value) -> Result<()> {
    let transcripts = arr(m, "transcripts", 1000)?;
    let notes = arr(m, "notes", 1000)?;
    if let Some(active) = m.get("activeTranscriptId") {
        if !active.is_null() && !transcripts.iter().any(|t| &t["id"] == active) {
            return Err(ApiError::bad(
                "The selected transcript does not belong to this meeting.",
            ));
        }
    }
    if let Some(active) = m.get("activeNotesId") {
        if !active.is_null() && !notes.iter().any(|t| &t["id"] == active) {
            return Err(ApiError::bad(
                "The selected notes do not belong to this meeting.",
            ));
        }
    }
    for n in notes {
        let t = transcripts
            .iter()
            .find(|t| t["id"] == n["transcriptVersionId"])
            .ok_or_else(|| ApiError::bad("Notes reference a missing source transcript."))?;
        for group in ["summary", "decisions", "actions"] {
            for note in n[group]
                .as_array()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            {
                for p in note["passageIds"]
                    .as_array()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                {
                    if !t["passages"]
                        .as_array()
                        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                        .iter()
                        .any(|v| &v["id"] == p)
                    {
                        return Err(ApiError::bad("A note references a passage that does not exist in its source transcript."));
                    }
                }
            }
        }
    }
    for moment in arr(m, "moments", 10000)? {
        if let Some(p) = moment.get("passageId").filter(|v| !v.is_null()) {
            if !transcripts.iter().any(|t| {
                t["passages"]
                    .as_array()
                    .is_some_and(|passages| passages.iter().any(|v| &v["id"] == p))
            }) {
                return Err(ApiError::bad(
                    "A saved moment references a missing passage.",
                ));
            }
        }
    }
    Ok(())
}
/// Accept safe HTTP meeting links without embedded credentials or control characters.
pub(super) fn validate_meeting_url(raw: &str) -> Result<()> {
    let parsed =
        reqwest::Url::parse(raw).map_err(|_| ApiError::bad("Use a valid HTTPS meeting link."))?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || raw.contains(['\r', '\n'])
    {
        return Err(ApiError::bad(
            "Use an HTTPS meeting link without embedded credentials.",
        ));
    }
    Ok(())
}
/// Validate the complete portable meeting document, including its history and references.
pub(crate) fn validate_meeting(m: &Value) -> Result<()> {
    object(
        m,
        &[
            "id",
            "title",
            "mode",
            "status",
            "createdAt",
            "updatedAt",
            "duration",
            "consent",
            "meetingUrl",
            "calendarEventId",
            "error",
            "tracks",
            "transcripts",
            "activeTranscriptId",
            "notes",
            "activeNotesId",
            "moments",
            "gaps",
            "speechModel",
            "notesModel",
            "liveTranscription",
            "demo",
            "extensionRecording",
            "autoTranscribeSuppressed",
        ],
    )?;
    identifier(m, "id", true)?;
    string(m, "title", 300, true)?;
    status(&m["status"])?;
    timestamp(m, "createdAt")?;
    timestamp(m, "updatedAt")?;
    number(m, "duration", true)?;
    boolean(m, "consent", true)?;
    boolean(m, "liveTranscription", true)?;
    boolean(m, "demo", false)?;
    boolean(m, "autoTranscribeSuppressed", false)?;
    if !matches!(m["mode"].as_str(), Some("in-person" | "online" | "import")) {
        return Err(ApiError::bad("Invalid recording mode."));
    }
    for key in ["speechModel", "notesModel"] {
        string(m, key, 200, true)?;
    }
    if let Some(url) = string(m, "meetingUrl", 2000, false)? {
        validate_meeting_url(url)?;
    }
    string(m, "calendarEventId", 500, false)?;
    string(m, "error", 4000, false)?;
    identifier(m, "activeTranscriptId", false)?;
    identifier(m, "activeNotesId", false)?;
    for key in ["tracks", "transcripts", "notes", "moments"] {
        unique(arr(
            m,
            key,
            if key == "tracks" {
                20
            } else if key == "moments" {
                10000
            } else {
                1000
            },
        )?)?;
    }
    for t in m["tracks"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
    {
        object(t, &["id", "label", "mimeType", "bytes", "url"])?;
        string(t, "label", 200, true)?;
        audio_type(
            string(t, "mimeType", 100, true)?
                .ok_or_else(|| ApiError::bad("A required value is missing."))?,
        )?;
        string(t, "url", 500, true)?;
        if t["bytes"]
            .as_u64()
            .filter(|b| *b <= 2 * 1024 * 1024 * 1024)
            .is_none()
        {
            return Err(ApiError::bad("Invalid audio track size."));
        }
    }
    for t in m["transcripts"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
    {
        validate_transcript(t, true)?;
    }
    for n in m["notes"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
    {
        validate_notes(n, true)?;
    }
    for m in m["moments"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
    {
        validate_moment(m, true)?;
    }
    if let Some(extension) = m.get("extensionRecording") {
        crate::extensions::validate_metadata(extension)?;
        let ids = extension["partTrackIds"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        let tracks = m["tracks"]
            .as_array()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
        if ids.len() != tracks.len()
            || ids
                .iter()
                .zip(tracks)
                .any(|(id, track)| id != &track["id"] || track["mimeType"] != "audio/wav")
        {
            return Err(ApiError::bad(
                "Sequential recording parts do not match their saved tracks.",
            ));
        }
        if !tracks.is_empty()
            && (tracks.iter().any(|track| {
                track["bytes"].as_u64().is_none_or(|bytes| {
                    bytes < 44 || (bytes - 44) % 2 != 0 || bytes > 44 + 16000 * 30 * 60 * 2
                })
            }) || tracks
                .iter()
                .filter_map(|track| {
                    track["bytes"]
                        .as_u64()
                        .map(|bytes| bytes.saturating_sub(44) / 2)
                })
                .sum::<u64>()
                != extension["totalFrames"]
                    .as_u64()
                    .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?)
        {
            return Err(ApiError::bad(
                "Sequential recording sizes do not match their frame timeline.",
            ));
        }
    }
    validate_gaps(m)?;
    validate_references(m)
}
