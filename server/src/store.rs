use crate::security::ApiError;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, ApiError>;
#[cfg(test)]
pub(crate) static TEST_LIBRARY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static DATABASE: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();
static WORKSPACE_LOCK: OnceLock<Mutex<Option<fs::File>>> = OnceLock::new();
const MAX_AUDIO: usize = 128 * 1024 * 1024;
const MAX_BACKUP: usize = 180 * 1024 * 1024;
/// Return a UTC timestamp with millisecond precision for persisted records.
pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
/// Generate an independent identifier for a new workspace entity.
fn id() -> String {
    Uuid::new_v4().to_string()
}
/// Resolve the library location from a developer override or shared runtime config.
pub fn data_dir() -> PathBuf {
    std::env::var_os("ECHO_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::config::get().data_dir.clone())
}
#[cfg(unix)]
/// Restrict managed data to the current account on Unix; other platforms use inherited ACLs.
pub(crate) fn secure(path: &Path, directory: bool) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(
        path,
        fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
    )?;
    Ok(())
}
#[cfg(not(unix))]
/// Restrict managed data to the current account on Unix; other platforms use inherited ACLs.
pub(crate) fn secure(_: &Path, _: bool) -> Result<()> {
    Ok(())
}
/// Create a managed folder and apply private directory permissions.
pub(crate) fn mkdir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    secure(path, true)
}
/// Write a new private file without replacing an existing recording chunk.
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(data)?;
    file.sync_all()?;
    Ok(())
}
/// Serialize database access, acquire the workspace lock, and initialize schema and recovery lazily.
pub(crate) fn with_db<T>(f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
    let mut guard = DATABASE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| {
            ApiError::new(
                500,
                "The workspace lock is unavailable. Restart Echo Voice.",
            )
        })?;
    if guard.is_none() {
        let root = data_dir();
        mkdir(&root)?;
        mkdir(&root.join("audio"))?;
        let lock_path = root.join("workspace.lock");
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        secure(&lock_path, false)?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_|ApiError::new(409,"Another Echo Voice server is using this data folder. Stop that server or choose a separate ECHO_DATA_DIR."))?;
        let mut db = Connection::open(root.join("workspace.sqlite"))?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS preferences(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS vocabulary(id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS deletion_jobs(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS audio_chunks(meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,track_id TEXT NOT NULL,sequence INTEGER NOT NULL,file TEXT NOT NULL,bytes INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(meeting_id,track_id,sequence));")?;
        for name in [
            "workspace.sqlite",
            "workspace.sqlite-wal",
            "workspace.sqlite-shm",
        ] {
            let p = root.join(name);
            if p.exists() {
                secure(&p, false)?;
            }
        }
        crate::extensions::init_schema(&db)?;
        recover(&mut db)?;
        *guard = Some(db);
        *WORKSPACE_LOCK
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| ApiError::new(500, "The workspace lock is unavailable."))? = Some(lock);
    }
    f(guard.as_mut().unwrap())
}
/// Open the library and complete startup recovery before accepting requests.
pub fn init() -> Result<()> {
    with_db(|_| Ok(()))
}
#[cfg(test)]
pub(crate) fn reset_for_tests() {
    if let Some(db) = DATABASE.get() {
        db.lock().unwrap().take();
    }
    if let Some(lock) = WORKSPACE_LOCK.get() {
        lock.lock().unwrap().take();
    }
}
/// Identify the restart marker that a still-running browser worker can reconcile.
const PROCESSING_RESTART_ERROR: &str = "Processing was interrupted by a server restart. Saved audio and earlier results are safe; retry processing.";
/// Resume durable deletion jobs and mark unfinished recording or processing work as interrupted.
fn recover(db: &mut Connection) -> Result<()> {
    let pending = {
        let mut stmt = db.prepare("SELECT id FROM deletion_jobs")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for key in pending {
        crate::extensions::tombstone(db, &key)?;
        if valid_id(&key).is_err() {
            continue;
        }
        let removed = (|| {
            for area in ["audio", "bot"] {
                let dir = data_dir().join(area).join(&key);
                if dir.exists() {
                    fs::remove_dir_all(dir)?;
                }
            }
            crate::extensions::cleanup_pcm(db, &key)?;
            Ok::<_, ApiError>(())
        })();
        if removed.is_ok() {
            db.execute("DELETE FROM meetings WHERE id=?", [&key])?;
            db.execute("DELETE FROM deletion_jobs WHERE id=?", [&key])?;
        } else {
            eprintln!("[Echo Voice] Pending deletion could not finish: {key}");
        }
    }
    let tx = db.transaction()?;
    let rows = {
        let mut stmt = tx.prepare("SELECT id,data FROM meetings")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<std::result::Result<Vec<_>, _>>()?
    };
    for (key, source) in rows {
        if let Ok(mut meeting) = serde_json::from_str::<Value>(&source) {
            if matches!(
                meeting["status"].as_str(),
                Some("recording" | "paused" | "processing")
            ) {
                let processing = meeting["status"] == "processing";
                meeting["status"] = json!(if processing { "error" } else { "interrupted" });
                meeting["error"] = json!(if processing {
                    PROCESSING_RESTART_ERROR
                } else {
                    "Recording was interrupted. Review your saved audio or start a new recording after checking consent and microphone access."
                });
                meeting["updatedAt"] = json!(now());
                tx.execute(
                    "UPDATE meetings SET data=? WHERE id=?",
                    params![meeting.to_string(), key],
                )?;
            }
        }
    }
    tx.commit()?;
    Ok(())
}
/// Reject identifiers that could escape managed paths or exceed supported lengths.
fn valid_id(value: &str) -> Result<()> {
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
fn object<'a>(v: &'a Value, allowed: &[&str]) -> Result<&'a serde_json::Map<String, Value>> {
    let obj = v
        .as_object()
        .ok_or_else(|| ApiError::bad("Expected a JSON object."))?;
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(ApiError::bad("The request contains unsupported fields."));
    }
    Ok(obj)
}
/// Validate optional or required text fields without silently coercing JSON types.
fn string<'a>(v: &'a Value, key: &str, max: usize, required: bool) -> Result<Option<&'a str>> {
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
fn number(v: &Value, key: &str, required: bool) -> Result<Option<f64>> {
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
fn boolean(v: &Value, key: &str, required: bool) -> Result<Option<bool>> {
    match v.get(key) {
        None if !required => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        _ => Err(ApiError::bad(format!("'{key}' must be true or false."))),
    }
}
/// Validate a bounded array before iterating user-supplied records.
fn arr<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>> {
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
fn identifier(v: &Value, key: &str, required: bool) -> Result<()> {
    if let Some(id) = string(v, key, 100, required)? {
        valid_id(id)?;
    }
    Ok(())
}
/// Require a parseable RFC 3339 timestamp for portable records.
fn timestamp(v: &Value, key: &str) -> Result<()> {
    let s = string(v, key, 100, true)?.unwrap();
    chrono::DateTime::parse_from_rfc3339(s)
        .map_err(|_| ApiError::bad(format!("'{key}' must be an ISO date.")))?;
    Ok(())
}
/// Reject duplicate entity IDs within a version or collection.
fn unique(items: &[Value]) -> Result<()> {
    let mut ids = HashSet::new();
    for item in items {
        identifier(item, "id", true)?;
        if !ids.insert(item["id"].as_str().unwrap()) {
            return Err(ApiError::bad("A list contains duplicate identifiers."));
        }
    }
    Ok(())
}
/// Validate a term, its aliases, enabled flag, and optional persisted identity.
fn validate_vocabulary(v: &Value, with_id: bool) -> Result<()> {
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
    let start = number(v, "start", true)?.unwrap();
    let end = number(v, "end", true)?.unwrap();
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
fn validate_transcript(v: &Value, with_id: bool) -> Result<()> {
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
fn validate_notes_provider(provider: &str) -> Result<()> {
    if !matches!(provider, "ollama" | "chatgpt") {
        return Err(ApiError::bad(
            "Choose Ollama or ChatGPT as the notes provider.",
        ));
    }
    Ok(())
}
/// Check optional token counts without accepting invented or malformed usage metadata.
fn validate_note_usage(usage: &Value) -> Result<()> {
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
fn validate_notes(v: &Value, with_id: bool) -> Result<()> {
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
fn validate_gaps(v: &Value) -> Result<()> {
    for gap in arr(v, "gaps", 10000)? {
        object(gap, &["start", "end", "reason"])?;
        if number(gap, "end", true)?.unwrap() < number(gap, "start", true)?.unwrap() {
            return Err(ApiError::bad("Gap end must be after its start."));
        }
        string(gap, "reason", 1000, true)?;
    }
    Ok(())
}
/// Validate a bookmark label, timestamp, and optional transcript passage reference.
fn validate_moment(v: &Value, with_id: bool) -> Result<()> {
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
fn status(v: &Value) -> Result<()> {
    if !matches!(
        v.as_str(),
        Some("recording" | "paused" | "saved" | "processing" | "ready" | "interrupted" | "error")
    ) {
        return Err(ApiError::bad("Invalid meeting status."));
    }
    Ok(())
}
/// Ensure active versions, evidence links, and bookmarks reference entities in this meeting.
fn validate_references(m: &Value) -> Result<()> {
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
            for note in n[group].as_array().unwrap() {
                for p in note["passageIds"].as_array().unwrap() {
                    if !t["passages"]
                        .as_array()
                        .unwrap()
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
                    .unwrap()
                    .iter()
                    .any(|v| &v["id"] == p)
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
fn validate_meeting_url(raw: &str) -> Result<()> {
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
    for t in m["tracks"].as_array().unwrap() {
        object(t, &["id", "label", "mimeType", "bytes", "url"])?;
        string(t, "label", 200, true)?;
        audio_type(string(t, "mimeType", 100, true)?.unwrap())?;
        string(t, "url", 500, true)?;
        if t["bytes"]
            .as_u64()
            .filter(|b| *b <= 2 * 1024 * 1024 * 1024)
            .is_none()
        {
            return Err(ApiError::bad("Invalid audio track size."));
        }
    }
    for t in m["transcripts"].as_array().unwrap() {
        validate_transcript(t, true)?;
    }
    for n in m["notes"].as_array().unwrap() {
        validate_notes(n, true)?;
    }
    for m in m["moments"].as_array().unwrap() {
        validate_moment(m, true)?;
    }
    if let Some(extension) = m.get("extensionRecording") {
        crate::extensions::validate_metadata(extension)?;
        let ids = extension["partTrackIds"].as_array().unwrap();
        let tracks = m["tracks"].as_array().unwrap();
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
                .map(|track| (track["bytes"].as_u64().unwrap() - 44) / 2)
                .sum::<u64>()
                != extension["totalFrames"].as_u64().unwrap())
        {
            return Err(ApiError::bad(
                "Sequential recording sizes do not match their frame timeline.",
            ));
        }
    }
    validate_gaps(m)?;
    validate_references(m)
}
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
fn list_db(db: &Connection) -> Result<Vec<Value>> {
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
                meeting.as_object_mut().unwrap().remove("error");
                save(&tx, &mut meeting)?;
                restored.push(key.clone());
            }
        }
        tx.commit()?;
        Ok(restored)
    })
}
/// Define initial workspace preferences for local speech and notes processing.
fn defaults() -> Value {
    json!({"name":"","speechModel":"onnx-community/whisper-large-v3-turbo","notesModel":"qwen2.5:3b","notesProvider":"ollama","chatgptModel":"","ollamaUrl":"http://127.0.0.1:11434","language":"en","autoTranscribe":true,"retainAudio":true,"onboardingComplete":false})
}
/// Merge saved preferences with current defaults and migrate legacy provider settings.
fn normalized_settings(saved: Value) -> Result<Value> {
    validate_settings(&saved, false)?;
    let mut settings = defaults();
    for (key, value) in saved.as_object().unwrap() {
        settings[key] = value.clone();
    }
    if matches!(
        settings["speechModel"].as_str(),
        Some("onnx-community/whisper-tiny.en" | "onnx-community/whisper-base")
    ) {
        settings["speechModel"] = json!("onnx-community/whisper-large-v3-turbo");
    }
    validate_settings(&settings, true)?;
    Ok(settings)
}
/// Read normalized preferences using an existing database transaction.
pub(crate) fn settings_db(db: &Connection) -> Result<Value> {
    let source: Option<String> = db
        .query_row(
            "SELECT data FROM preferences WHERE id='settings'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    normalized_settings(match source {
        Some(s) => serde_json::from_str(&s)?,
        None => json!({}),
    })
}
/// Return current workspace preferences with migrations applied.
pub fn get_settings() -> Result<Value> {
    with_db(|db| settings_db(db))
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
    let consent = boolean(&input, "consent", true)?.unwrap();
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
        for (k, v) in patch.as_object().unwrap() {
            if v.is_null() {
                m.as_object_mut().unwrap().remove(k);
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
        if data_dir()
            .join("bot-starts")
            .join(format!("{key}.json"))
            .exists()
        {
            return Err(ApiError::new(409, "A recording start is still being reconciled. Stop the meeting assistant before deleting this meeting."));
        }
        let session_file = data_dir().join("bot").join(key).join("session.json");
        if session_file.exists() {
            let session: Value = serde_json::from_slice(&fs::read(session_file)?)?;
            if matches!(
                session["status"].as_str(),
                Some("joining" | "waiting" | "recording" | "stopping")
            ) {
                return Err(ApiError::new(
                    409,
                    "Stop the meeting assistant before deleting its recording.",
                ));
            }
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
            for area in ["audio", "bot"] {
                let dir = data_dir().join(area).join(key);
                if dir.exists() {
                    fs::remove_dir_all(dir)?;
                }
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
/// Read saved vocabulary in display order using an existing database connection.
fn vocabulary_db(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT data FROM vocabulary ORDER BY rowid")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
}
/// Return the shared vocabulary used during local transcription.
pub fn list_vocabulary() -> Result<Vec<Value>> {
    with_db(|db| vocabulary_db(db))
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
        if m["transcripts"].as_array().unwrap().len() >= 1000 {
            return Err(ApiError::bad(
                "This meeting reached its 1,000-version history limit.",
            ));
        }
        crate::extensions::final_succeeded(&tx, key)?;
        input["id"] = json!(id());
        input["createdAt"] = json!(now());
        m["activeTranscriptId"] = input["id"].clone();
        m["transcripts"].as_array_mut().unwrap().push(input);
        m.as_object_mut().unwrap().remove("error");
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
        if m["notes"].as_array().unwrap().len() >= 1000 {
            return Err(ApiError::bad(
                "This meeting reached its 1,000-version notes limit.",
            ));
        }
        if input["edited"] == true {
            if let Some(source) = m["notes"].as_array().unwrap().iter().find(|note| {
                note["id"] == m["activeNotesId"]
                    && note["model"] == input["model"]
                    && note["transcriptVersionId"] == input["transcriptVersionId"]
            }) {
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
        m["notes"].as_array_mut().unwrap().push(input);
        validate_references(&m)?;
        m.as_object_mut().unwrap().remove("error");
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
        if m["moments"].as_array().unwrap().len() >= 10000 {
            return Err(ApiError::bad("This meeting has too many saved moments."));
        }
        input["id"] = json!(id());
        m["moments"].as_array_mut().unwrap().push(input);
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
            .unwrap()
            .iter_mut()
            .find(|v| v["id"] == moment_id)
            .ok_or_else(|| ApiError::new(404, "This saved moment could not be found."))?;
        for (k, v) in patch.as_object().unwrap() {
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
        let moments = m["moments"].as_array_mut().unwrap();
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
/// Validate preference fields and enforce local provider URLs and supported provider choices.
fn validate_settings(v: &Value, full: bool) -> Result<()> {
    object(
        v,
        &[
            "name",
            "speechModel",
            "notesModel",
            "notesProvider",
            "chatgptModel",
            "ollamaUrl",
            "language",
            "autoTranscribe",
            "retainAudio",
            "onboardingComplete",
        ],
    )?;
    string(v, "name", 120, false)?;
    if let Some(provider) = string(v, "notesProvider", 20, full)? {
        validate_notes_provider(provider)?;
    }
    if let Some(model) = string(v, "chatgptModel", 200, false)? {
        if !model.is_empty()
            && (!model.as_bytes()[0].is_ascii_alphanumeric()
                || !model
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"._:/-".contains(&c))
                || model.contains("..")
                || model.contains("//"))
        {
            return Err(ApiError::bad(
                "Choose a valid ChatGPT model, or leave it empty to use the account default.",
            ));
        }
    }
    if full && v.get("chatgptModel").is_none() {
        return Err(ApiError::bad("The ChatGPT model setting is missing."));
    }
    for key in ["speechModel", "notesModel", "language"] {
        string(v, key, 200, full || v.get(key).is_some())?;
    }
    for key in ["autoTranscribe", "retainAudio", "onboardingComplete"] {
        boolean(v, key, full)?;
    }
    if let Some(url) = string(v, "ollamaUrl", 500, full)? {
        let parsed = reqwest::Url::parse(url)
            .map_err(|_| ApiError::bad("Enter a valid local Ollama URL."))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !matches!(
                parsed.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            )
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.path() != "/"
        {
            return Err(ApiError::bad("The notes provider must use localhost, 127.0.0.1, or ::1 without credentials or a path."));
        }
    }
    Ok(())
}
/// Merge an allowlisted preference patch and persist the validated result.
pub fn update_settings(patch: Value) -> Result<Value> {
    validate_settings(&patch, false)?;
    with_db(|db| {
        let mut settings = settings_db(db)?;
        for (k, v) in patch.as_object().unwrap() {
            settings[k] = v.clone();
        }
        validate_settings(&settings, true)?;
        db.execute("INSERT INTO preferences VALUES('settings',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[settings.to_string()])?;
        Ok(settings)
    })
}
/// Create a validated term and aliases with a stable identity.
pub fn add_vocabulary(mut input: Value) -> Result<Value> {
    object(&input, &["term", "aliases", "enabled"])?;
    if input.get("aliases").is_none() {
        input["aliases"] = json!([]);
    }
    if input.get("enabled").is_none() {
        input["enabled"] = json!(true);
    }
    validate_vocabulary(&input, false)?;
    input["id"] = json!(id());
    with_db(|db| {
        let count: i64 = db.query_row("SELECT COUNT(*) FROM vocabulary", [], |r| r.get(0))?;
        if count >= 10000 {
            return Err(ApiError::bad(
                "Your vocabulary reached its 10,000-entry limit.",
            ));
        }
        db.execute(
            "INSERT INTO vocabulary VALUES(?,?)",
            params![input["id"].as_str(), input.to_string()],
        )?;
        Ok(input)
    })
}
/// Apply a validated vocabulary patch to an existing term.
pub fn update_vocabulary(key: &str, patch: Value) -> Result<Value> {
    valid_id(key)?;
    object(&patch, &["term", "aliases", "enabled"])?;
    with_db(|db| {
        let source: Option<String> = db
            .query_row("SELECT data FROM vocabulary WHERE id=?", [key], |r| {
                r.get(0)
            })
            .optional()?;
        let mut entry: Value = serde_json::from_str(
            &source
                .ok_or_else(|| ApiError::new(404, "This vocabulary entry could not be found."))?,
        )?;
        for (k, v) in patch.as_object().unwrap() {
            entry[k] = v.clone();
        }
        validate_vocabulary(&entry, true)?;
        db.execute(
            "UPDATE vocabulary SET data=? WHERE id=?",
            params![entry.to_string(), key],
        )?;
        Ok(entry)
    })
}
/// Remove a term without altering the snapshots attached to saved transcripts.
pub fn delete_vocabulary(key: &str) -> Result<()> {
    valid_id(key)?;
    with_db(|db| {
        if db.execute("DELETE FROM vocabulary WHERE id=?", [key])? == 0 {
            return Err(ApiError::new(
                404,
                "This vocabulary entry could not be found.",
            ));
        }
        Ok(())
    })
}
/// Canonicalize supported audio MIME types and reject unknown containers.
fn audio_type(value: &str) -> Result<String> {
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
fn audio_header(data: &[u8], mime: &str) -> Result<()> {
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
fn audio_url(meeting: &str, track: &str) -> String {
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
            .unwrap()
            .iter()
            .find(|t| t["id"] == track_id)
            .cloned();
        let last: Option<i64> = tx.query_row(
            "SELECT MAX(sequence) FROM audio_chunks WHERE meeting_id=? AND track_id=?",
            params![key, track_id],
            |r| r.get(0),
        )?;
        let seq = sequence.unwrap_or(last.map(|s| s + 1).unwrap_or(0));
        let existing: Option<String> = tx
            .query_row(
                "SELECT digest FROM audio_chunks WHERE meeting_id=? AND track_id=? AND sequence=?",
                params![key, track_id, seq],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(hash) = existing {
            if hash != digest {
                return Err(ApiError::new(409,"A different audio chunk already uses this sequence. Retry its original content."));
            }
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
        } else if m["tracks"].as_array().unwrap().len() >= 20 {
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
        let dir = data_dir().join("audio").join(key);
        mkdir(&dir)?;
        let name = format!("{track_id}-{seq}-{}.chunk", id());
        let path = dir.join(&name);
        written = Some(path.clone());
        write_private(&path, data)?;
        tx.execute(
            "INSERT INTO audio_chunks VALUES(?,?,?,?,?,?)",
            params![key, track_id, seq, name, data.len() as i64, digest],
        )?;
        let track = json!({"id":track_id,"label":label,"mimeType":mime,"bytes":bytes,"url":audio_url(key,track_id)});
        let tracks = m["tracks"].as_array_mut().unwrap();
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
            .unwrap()
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
            let path = data_dir().join("audio").join(key).join(file);
            if !path.exists()
                || fs::symlink_metadata(&path)?.file_type().is_symlink()
                || fs::metadata(&path)?.len() != bytes
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
    let root = data_dir();
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
        let mut stmt=db.prepare("SELECT meeting_id,track_id,sequence,file,bytes FROM audio_chunks ORDER BY meeting_id,track_id,sequence")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, u64>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if rows.iter().map(|r| r.4).sum::<u64>() > MAX_BACKUP as u64 {
            return Err(ApiError::new(413,"This library is too large for a browser backup. Stop Echo Voice and copy its entire data folder to your backup disk."));
        }
        let mut audio = Vec::new();
        for (meeting, track, sequence, file, bytes) in rows {
            valid_id(&meeting)?;
            valid_id(&track)?;
            if Path::new(&file).file_name().and_then(|s| s.to_str()) != Some(&file) {
                return Err(ApiError::new(500, "An audio storage reference is invalid."));
            }
            let path = data_dir().join("audio").join(&meeting).join(file);
            if fs::symlink_metadata(&path)?.file_type().is_symlink() {
                return Err(ApiError::new(500, "Audio links cannot be exported."));
            }
            let data = fs::read(path)?;
            if data.len() as u64 != bytes {
                return Err(ApiError::new(
                    410,
                    "An audio file is incomplete. Restore it before creating a backup.",
                ));
            }
            audio.push(json!({"meetingId":meeting,"trackId":track,"sequence":sequence,"data":STANDARD.encode(data)}));
        }
        let mut settings = settings_db(db)?;
        settings.as_object_mut().unwrap().remove("ollamaUrl");
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
        for (k, v) in imported.as_object().unwrap() {
            settings[k] = v.clone();
        }
        validate_settings(&settings, true)?;
    }
    let mut tracks = HashMap::new();
    for m in meetings {
        for track in m["tracks"].as_array().unwrap() {
            tracks.insert(
                format!(
                    "{}/{}",
                    m["id"].as_str().unwrap(),
                    track["id"].as_str().unwrap()
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
            c["meetingId"].as_str().unwrap(),
            c["trackId"].as_str().unwrap(),
            c["sequence"].as_i64().unwrap(),
        )
    });
    let mut sizes = HashMap::<String, u64>::new();
    let mut sequences = HashMap::<String, i64>::new();
    let mut prepared = Vec::new();
    let mut total = 0usize;
    for chunk in chunks {
        let meeting = chunk["meetingId"].as_str().unwrap();
        let track_id = chunk["trackId"].as_str().unwrap();
        let key = format!("{meeting}/{track_id}");
        let track = tracks.get(&key).ok_or_else(|| {
            ApiError::bad("The backup contains audio without a matching meeting track.")
        })?;
        let sequence = chunk["sequence"].as_i64().unwrap();
        if sequence != *sequences.get(&key).unwrap_or(&0) {
            return Err(ApiError::bad(
                "The backup contains missing or duplicate audio chunks.",
            ));
        }
        let data = STANDARD
            .decode(chunk["data"].as_str().unwrap())
            .map_err(|_| ApiError::bad("The backup contains invalid audio encoding."))?;
        if data.is_empty() || data.len() > MAX_AUDIO {
            return Err(ApiError::bad(
                "The backup contains an invalid audio chunk size.",
            ));
        }
        if sequence == 0 {
            audio_header(&data, track["mimeType"].as_str().unwrap())?;
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
    let staging = data_dir().join(format!(".import-{}", id()));
    mkdir(&staging)?;
    let mut installed = Vec::<PathBuf>::new();
    let outcome = (|| {
        for chunk in &prepared {
            let dir = staging.join(&chunk.meeting);
            mkdir(&dir)?;
            write_private(&dir.join(&chunk.filename), &chunk.data)?;
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
                let key = m["id"].as_str().unwrap().to_string();
                for t in m["tracks"].as_array_mut().unwrap() {
                    t["url"] = json!(audio_url(&key, t["id"].as_str().unwrap()));
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
                    let dest = data_dir().join("audio").join(&key);
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
        .unwrap()
        .iter()
        .find(|v| v["id"] == m["activeTranscriptId"]);
    let notes = m["notes"]
        .as_array()
        .unwrap()
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
            for n in notes[group].as_array().unwrap() {
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
                        .unwrap()
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
    if !m["moments"].as_array().unwrap().is_empty() {
        body.push_str("\n## Saved moments\n");
        for moment in m["moments"].as_array().unwrap() {
            body.push_str(&format!(
                "- [{}] {}: {} [{}]\n",
                stamp(moment["time"].as_f64().unwrap_or(0.0), false),
                strv(moment, "kind"),
                strv(moment, "label"),
                strv(moment, "passageId")
            ));
        }
    }
    if !m["gaps"].as_array().unwrap().is_empty() {
        body.push_str("\n## Recording gaps\n");
        for gap in m["gaps"].as_array().unwrap() {
            body.push_str(&format!(
                "- {}–{}: {}\n",
                stamp(gap["start"].as_f64().unwrap_or(0.0), false),
                stamp(gap["end"].as_f64().unwrap_or(0.0), false),
                strv(gap, "reason")
            ));
        }
    }
    if !m["tracks"].as_array().unwrap().is_empty() {
        body.push_str("\n## Audio tracks\n");
        for t in m["tracks"].as_array().unwrap() {
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_migrate_to_local_and_usage_metadata_is_strict() {
        let mut legacy = defaults();
        legacy.as_object_mut().unwrap().remove("notesProvider");
        legacy.as_object_mut().unwrap().remove("chatgptModel");
        let migrated = normalized_settings(legacy).unwrap();
        assert_eq!(migrated["notesProvider"], "ollama");
        assert_eq!(migrated["chatgptModel"], "");
        assert_eq!(
            normalized_settings(json!({"notesProvider":"chatgpt"})).unwrap()["chatgptModel"],
            ""
        );
        for value in [
            json!({"notesProvider":"api-key"}),
            json!({"notesProvider":null}),
            json!({"chatgptModel":12}),
            json!({"chatgptModel":"bad\nmodel"}),
        ] {
            assert!(validate_settings(&value, false).is_err());
        }
        assert!(validate_settings(
            &json!({"notesProvider":"chatgpt","chatgptModel":"gpt-5.4"}),
            false
        )
        .is_ok());
        for usage in [
            json!({"inputTokens":-1}),
            json!({"outputTokens":1.5}),
            json!({"inputTokens":2,"cachedInputTokens":3}),
            json!({"apiKey":"never-import"}),
            json!({"inputTokens":null}),
        ] {
            assert!(validate_note_usage(&usage).is_err());
        }
        assert!(validate_note_usage(
            &json!({"inputTokens":12,"outputTokens":3,"cachedInputTokens":0})
        )
        .is_ok());
        let mut note = json!({"model":"gpt-5.4","provider":"chatgpt","usage":{"inputTokens":12,"outputTokens":3},"transcriptVersionId":"source","summary":[],"decisions":[],"actions":[]});
        assert!(validate_notes(&note, false).is_ok());
        note["provider"] = json!("api-key");
        assert!(validate_notes(&note, false).is_err());
    }

    #[test]
    fn durable_recording_versions_backup_validation_and_recovery() {
        let _guard = TEST_LIBRARY_LOCK.blocking_lock();
        let directory = tempfile::tempdir().unwrap();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        init().unwrap();
        let competing = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.path().join("workspace.lock"))
            .unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&competing).is_err());
        assert!(
            create_meeting(json!({"title":"No consent","mode":"in-person","consent":false}))
                .is_err()
        );
        assert!(get_meeting("../../credentials").is_err());
        assert!(update_settings(json!({"ollamaUrl":"http://example.com"})).is_err());
        assert!(update_settings(json!({"ollamaUrl":"http://localhost:11434@evil.com"})).is_err());
        assert!(update_settings(json!({"ollamaUrl":"http://127.0.0.1:11434/path"})).is_err());
        update_settings(json!({"name":"Asha","ollamaUrl":"http://127.0.0.1:11434"})).unwrap();
        let m = create_meeting(
            json!({"title":"Roadmap","mode":"in-person","consent":true,"liveTranscription":true}),
        )
        .unwrap();
        let key = m["id"].as_str().unwrap();
        let cancelled = update_meeting(key, json!({"autoTranscribeSuppressed":true})).unwrap();
        assert_eq!(
            get_meeting(key).unwrap().unwrap()["autoTranscribeSuppressed"],
            true
        );
        assert!(validate_meeting(&cancelled).is_ok());
        assert!(update_meeting(key, json!({"autoTranscribeSuppressed":"yes"})).is_err());
        assert_eq!(
            update_meeting(key, json!({"autoTranscribeSuppressed":false})).unwrap()
                ["autoTranscribeSuppressed"],
            false
        );
        let audio = b"RIFF\x24\x00\x00\x00WAVEfmt original-audio";
        let track = add_audio(
            key,
            audio,
            Some("room"),
            "Room microphone",
            "audio/wav",
            Some(0),
        )
        .unwrap();
        assert_eq!(
            add_audio(
                key,
                audio,
                Some("room"),
                "Room microphone",
                "audio/wav",
                Some(0)
            )
            .unwrap(),
            track
        );
        assert!(add_audio(
            key,
            b"different",
            Some("room"),
            "Room microphone",
            "audio/wav",
            Some(0)
        )
        .is_err());
        assert!(add_audio(
            key,
            b"chunk",
            Some("room"),
            "Room microphone",
            "audio/wav",
            Some(2)
        )
        .is_err());
        add_audio(
            key,
            b"second-chunk",
            Some("room"),
            "Room microphone",
            "audio/wav",
            Some(1),
        )
        .unwrap();
        let (_, parts) = get_audio_parts(key, "room").unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(fs::read(&parts[0].path).unwrap(), audio);
        assert!(add_audio(
            key,
            b"<script>executable</script>",
            Some("bad"),
            "Bad file",
            "audio/wav",
            Some(0)
        )
        .is_err());
        // A browser worker can survive a server restart. Reconcile only its
        // claimed meeting, leaving genuinely abandoned jobs interrupted.
        let orphan = create_meeting(
            json!({"title":"Abandoned server work","mode":"in-person","consent":true}),
        )
        .unwrap();
        let orphan_id = orphan["id"].as_str().unwrap();
        update_meeting(key, json!({"status":"processing"})).unwrap();
        update_meeting(orphan_id, json!({"status":"processing"})).unwrap();
        with_db(recover).unwrap();
        assert_eq!(get_meeting(key).unwrap().unwrap()["status"], "error");
        assert_eq!(resume_browser_processing(&[key.into()]).unwrap(), vec![key]);
        assert_eq!(get_meeting(key).unwrap().unwrap()["status"], "processing");
        assert!(get_meeting(key).unwrap().unwrap().get("error").is_none());
        assert_eq!(get_meeting(orphan_id).unwrap().unwrap()["status"], "error");
        update_meeting(
            key,
            json!({"status":"error","error":"The speech runtime failed."}),
        )
        .unwrap();
        assert!(resume_browser_processing(&[key.into()]).unwrap().is_empty());
        assert_eq!(
            get_meeting(key).unwrap().unwrap()["error"],
            "The speech runtime failed."
        );
        update_meeting(
            key,
            json!({"status":"error","error":PROCESSING_RESTART_ERROR}),
        )
        .unwrap();
        delete_meeting(orphan_id).unwrap();
        assert!(resume_browser_processing(&["../../credentials".into()]).is_err());
        add_vocabulary(json!({"term":"Echo Voice","aliases":["echo boys"]})).unwrap();
        let first=add_transcript(key,json!({"model":"whisper-tiny.en","passages":[{"id":"p1","start":0,"end":2,"speaker":"Speaker 1","text":"Ship Friday."}]})).unwrap();
        assert_eq!(first["status"], "ready");
        assert!(first.get("error").is_none());
        assert!(resume_browser_processing(&[key.into()]).unwrap().is_empty());
        assert_eq!(
            get_meeting(key).unwrap().unwrap()["transcripts"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let first_id = first["activeTranscriptId"].clone();
        add_notes(key,json!({"model":"qwen2.5:3b","transcriptVersionId":first_id,"summary":[{"id":"s1","text":"A Friday release was proposed.","passageIds":["p1"]}],"decisions":[],"actions":[]})).unwrap();
        assert!(add_notes(key,json!({"model":"model","transcriptVersionId":first_id,"summary":[{"id":"s2","text":"Invented","passageIds":["missing"]}],"decisions":[],"actions":[]})).is_err());
        let cloud_source = json!({"provider":"chatgpt","model":"gpt-5.4","usage":{"inputTokens":100,"outputTokens":25,"cachedInputTokens":40},"transcriptVersionId":first_id,"summary":[{"id":"c1","text":"A Friday release was proposed.","passageIds":["p1"]}],"decisions":[],"actions":[]});
        let cloud_saved =
            add_generated_notes(key, cloud_source.clone(), first_id.as_str().unwrap()).unwrap();
        let mut cloud_edit = cloud_source;
        cloud_edit.as_object_mut().unwrap().remove("provider");
        cloud_edit.as_object_mut().unwrap().remove("usage");
        cloud_edit["edited"] = json!(true);
        cloud_edit["summary"][0]["text"] = json!("Reviewed release proposal.");
        let edited_notes = add_notes(key, cloud_edit).unwrap();
        assert_eq!(edited_notes["notes"][1], cloud_saved["notes"][1]);
        assert_eq!(edited_notes["notes"][2]["provider"], "chatgpt");
        assert_eq!(edited_notes["notes"][2]["usage"]["cachedInputTokens"], 40);
        let second=add_transcript(key,json!({"model":"manual-edit","passages":[{"id":"p1","start":0,"end":2,"speaker":"Asha","text":"Ship next Friday."}],"vocabulary":[]})).unwrap();
        assert_eq!(second["transcripts"].as_array().unwrap().len(), 2);
        let stale_notes = json!({"model":"gpt-5.4","provider":"chatgpt","transcriptVersionId":first_id,"summary":[],"decisions":[],"actions":[]});
        assert_eq!(
            add_generated_notes(key, stale_notes, first_id.as_str().unwrap())
                .unwrap_err()
                .status
                .as_u16(),
            409
        );
        assert_eq!(
            get_meeting(key).unwrap().unwrap()["notes"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(second["notes"][0]["transcriptVersionId"], first_id);
        assert_eq!(
            second["transcripts"][0]["passages"][0]["text"],
            "Ship Friday."
        );
        assert_eq!(
            second["transcripts"][0]["vocabulary"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(update_meeting(
            key,
            json!({"activeTranscriptId":"some-other-meeting-version"})
        )
        .is_err());
        let marked = add_moment(
            key,
            json!({"time":1,"label":"Release date","passageId":"p1","kind":"highlight"}),
        )
        .unwrap();
        let moment_id = marked["moments"][0]["id"].as_str().unwrap();
        update_moment(key, moment_id, json!({"label":"Verify release"})).unwrap();
        update_meeting(key,json!({"liveTranscription":false,"gaps":[{"start":2,"end":3,"reason":"Microphone muted"}]})).unwrap();
        assert!(update_meeting(key, json!({"liveTranscription":true})).is_err());
        let (markdown, _, _) = export_meeting(key, "md").unwrap();
        assert!(markdown.contains("earlier transcript"));
        assert!(markdown.contains("Microphone muted"));
        assert!(markdown.contains("Verify release"));
        let (srt, _, _) = export_meeting(key, "srt").unwrap();
        assert!(srt.contains("00:00:00,000 --> 00:00:02,000"));
        let backup = export_library().unwrap();
        assert!(backup["settings"].get("ollamaUrl").is_none());
        assert!(import_library(backup.clone()).is_err());
        update_meeting(key, json!({"status":"recording"})).unwrap();
        assert!(delete_meeting(key).is_err());
        with_db(recover).unwrap();
        let recovered = get_meeting(key).unwrap().unwrap();
        assert_eq!(recovered["status"], "interrupted");
        assert_eq!(recovered["transcripts"].as_array().unwrap().len(), 2);
        delete_meeting(key).unwrap();
        for entry in list_vocabulary().unwrap() {
            delete_vocabulary(entry["id"].as_str().unwrap()).unwrap();
        }
        assert!(!data_dir().join("audio").join(key).exists());
        let mut malformed = backup.clone();
        malformed["credentials"] = json!({"token":"must-not-import"});
        assert!(import_library(malformed).is_err());
        let mut traversal = backup.clone();
        traversal["meetings"][0]["id"] = json!("../../credentials");
        assert!(import_library(traversal).is_err());
        let mut executable = backup.clone();
        executable["audio"][0]["data"] = json!(STANDARD.encode(b"#!/bin/sh\nrm -rf /"));
        assert!(import_library(executable).is_err());
        assert_eq!(list_meetings().unwrap().len(), 0);
        let mut legacy = backup.clone();
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("notesProvider");
        legacy["settings"]
            .as_object_mut()
            .unwrap()
            .remove("chatgptModel");
        for note in legacy["meetings"][0]["notes"].as_array_mut().unwrap() {
            note.as_object_mut().unwrap().remove("provider");
            note.as_object_mut().unwrap().remove("usage");
        }
        update_settings(json!({"notesProvider":"chatgpt","chatgptModel":"gpt-5.4"})).unwrap();
        import_library(legacy).unwrap();
        assert_eq!(get_settings().unwrap()["notesProvider"], "ollama");
        assert_eq!(get_settings().unwrap()["chatgptModel"], "");
        delete_meeting(key).unwrap();
        for entry in list_vocabulary().unwrap() {
            delete_vocabulary(entry["id"].as_str().unwrap()).unwrap();
        }
        let restored = import_library(backup).unwrap();
        assert_eq!(restored["meetings"], 1);
        let restored_meeting = get_meeting(key).unwrap().unwrap();
        assert_eq!(restored_meeting["notes"][2]["provider"], "chatgpt");
        assert_eq!(
            restored_meeting["notes"][2]["usage"],
            json!({"inputTokens":100,"outputTokens":25,"cachedInputTokens":40})
        );
        assert_eq!(
            restored_meeting["notes"][2]["summary"][0]["text"],
            "Reviewed release proposal."
        );
        assert_eq!(
            get_meeting(key).unwrap().unwrap()["transcripts"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let (_, parts) = get_audio_parts(key, "room").unwrap();
        assert_eq!(fs::read(&parts[0].path).unwrap(), audio);
        let disk = Connection::open(directory.path().join("workspace.sqlite")).unwrap();
        let saved: String = disk
            .query_row("SELECT data FROM meetings WHERE id=?", [key], |r| r.get(0))
            .unwrap();
        assert!(saved.contains("Ship next Friday."));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path().join("workspace.sqlite"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(&parts[0].path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let pending =
            create_meeting(json!({"title":"Delete on recovery","mode":"import","consent":false}))
                .unwrap();
        let pending_id = pending["id"].as_str().unwrap();
        add_audio(
            pending_id,
            audio,
            Some("room"),
            "Room microphone",
            "audio/wav",
            Some(0),
        )
        .unwrap();
        with_db(|db| {
            db.execute("INSERT INTO deletion_jobs(id) VALUES(?)", [pending_id])?;
            recover(db)
        })
        .unwrap();
        assert!(get_meeting(pending_id).unwrap().is_none());
        assert!(!directory.path().join("audio").join(pending_id).exists());
        with_db(|db| {
            db.execute("INSERT INTO meetings VALUES('damaged','{')", [])?;
            Ok(())
        })
        .unwrap();
        assert_eq!(list_meetings().unwrap().len(), 1);
        assert!(export_library().is_err());
        with_db(|db| {
            db.execute("DELETE FROM meetings WHERE id='damaged'", [])?;
            Ok(())
        })
        .unwrap();
        DATABASE.get().unwrap().lock().unwrap().take();
        WORKSPACE_LOCK.get().unwrap().lock().unwrap().take();
        std::env::remove_var("ECHO_DATA_DIR");
    }
}
