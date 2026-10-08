//! Narrow browser-extension pairing and durable PCM ingest, separate from normal API access.
use crate::{security::ApiError, store};
use axum::{
    body::{to_bytes, Bytes},
    extract::{DefaultBodyLimit, Path, Query, Request},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use uuid::Uuid;
type Result<T> = std::result::Result<T, ApiError>;
type PairingReservation = (i64, Option<String>, Option<String>, Option<String>);
const RATE: u64 = 16000;
const MAX_FRAMES: u64 = RATE * 8 * 3600;
const PART_FRAMES: u64 = RATE * 30 * 60;
fn seconds() -> i64 {
    chrono::Utc::now().timestamp()
}
fn hash(data: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(data.as_ref()))
}
fn uid(raw: &str) -> Result<()> {
    if Uuid::parse_str(raw).is_err() || raw.len() != 36 {
        Err(ApiError::bad("Use a UUID identifier."))
    } else {
        Ok(())
    }
}
fn text<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= max)
        .ok_or_else(|| ApiError::bad(format!("Invalid {key}.")))
}
fn fields(v: &Value, allowed: &[&str]) -> Result<()> {
    if v.as_object()
        .is_none_or(|m| m.keys().any(|k| !allowed.contains(&k.as_str())))
    {
        Err(ApiError::bad("Unsupported request fields."))
    } else {
        Ok(())
    }
}
fn reply(mut value: Value) -> Json<Value> {
    value["protocolVersion"] = json!(1);
    Json(value)
}
pub(crate) fn init_schema(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS extension_library(id INTEGER PRIMARY KEY CHECK(id=1),library_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS extension_pairing(code_hash TEXT PRIMARY KEY,expires INTEGER NOT NULL,request_id TEXT UNIQUE,installation_id TEXT,name TEXT,origin TEXT,state TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS extension_connections(installation_id TEXT PRIMARY KEY,name TEXT NOT NULL,origin TEXT NOT NULL,credential_hash TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS extension_recordings(recording_id TEXT PRIMARY KEY,installation_id TEXT NOT NULL,meeting_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS extension_chunks(recording_id TEXT NOT NULL,sequence INTEGER NOT NULL,frames INTEGER NOT NULL,digest TEXT NOT NULL,file TEXT NOT NULL,PRIMARY KEY(recording_id,sequence));")?;
    db.execute(
        "INSERT OR IGNORE INTO extension_library VALUES(1,?)",
        [Uuid::new_v4().to_string()],
    )?;
    Ok(())
}
fn library(db: &Connection) -> Result<String> {
    Ok(db.query_row(
        "SELECT library_id FROM extension_library WHERE id=1",
        [],
        |r| r.get(0),
    )?)
}
fn recording(db: &Connection, id: &str) -> Result<Value> {
    uid(id)?;
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM extension_recordings WHERE recording_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into))
        .unwrap_or_else(|| Err(ApiError::not_found()))
}
fn save_recording(db: &Connection, r: &Value) -> Result<()> {
    db.execute(
        "UPDATE extension_recordings SET data=? WHERE recording_id=?",
        params![r.to_string(), r["recordingId"].as_str()],
    )?;
    Ok(())
}
fn public_recording(mut r: Value, lib: &str) -> Value {
    r.as_object_mut().unwrap().remove("lease");
    r.as_object_mut().unwrap().remove("manifest");
    r.as_object_mut().unwrap().remove("input");
    r.as_object_mut().unwrap().remove("controlHistory");
    r["libraryId"] = json!(lib);
    r
}
fn extension_recording(r: Value, lib: &str) -> Value {
    let mut value = public_recording(r, lib);
    value.as_object_mut().unwrap().remove("draft");
    value.as_object_mut().unwrap().remove("liveStatus");
    value
}
pub(crate) fn validate_metadata(v: &Value) -> Result<()> {
    fields(
        v,
        &[
            "recordingId",
            "installationId",
            "libraryId",
            "partTrackIds",
            "totalFrames",
            "sampleRate",
        ],
    )?;
    for k in ["recordingId", "installationId", "libraryId"] {
        uid(text(v, k, 36)?)?;
    }
    if v["sampleRate"] != RATE
        || v["totalFrames"].as_u64().is_none_or(|n| n > MAX_FRAMES)
        || v["partTrackIds"].as_array().is_none_or(|a| {
            a.len() > 16
                || a.iter()
                    .any(|s| s.as_str().is_none_or(|id| uid(id).is_err()))
        })
    {
        return Err(ApiError::bad("Invalid sequential recording metadata."));
    }
    Ok(())
}
pub(crate) fn tombstone(db: &Connection, meeting: &str) -> Result<()> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM extension_recordings WHERE meeting_id=?",
            [meeting],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = raw {
        let mut r: Value = serde_json::from_str(&raw)?;
        r["status"] = json!("deleted");
        r["controls"] = json!([]);
        r.as_object_mut().unwrap().remove("draft");
        r.as_object_mut().unwrap().remove("lease");
        for key in [
            "input",
            "title",
            "provider",
            "createdAt",
            "manifest",
            "controlHistory",
        ] {
            r.as_object_mut().unwrap().remove(key);
        }
        save_recording(db, &r)?;
        db.execute(
            "DELETE FROM extension_chunks WHERE recording_id=?",
            [r["recordingId"].as_str()],
        )?;
    }
    Ok(())
}
pub(crate) fn preempt(db: &Connection, meeting: &str) -> Result<()> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM extension_recordings WHERE meeting_id=?",
            [meeting],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = raw {
        let mut r: Value = serde_json::from_str(&raw)?;
        r["generation"] = json!(r["generation"].as_u64().unwrap_or(0) + 1);
        r.as_object_mut().unwrap().remove("lease");
        save_recording(db, &r)?;
    }
    Ok(())
}
pub(crate) fn final_succeeded(db: &Connection, meeting: &str) -> Result<()> {
    preempt(db, meeting)?;
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM extension_recordings WHERE meeting_id=?",
            [meeting],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(raw) = raw {
        let mut r: Value = serde_json::from_str(&raw)?;
        r.as_object_mut().unwrap().remove("draft");
        save_recording(db, &r)?;
    }
    Ok(())
}
fn extension_origin(headers: &HeaderMap) -> Result<String> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let id = origin.strip_prefix("chrome-extension://").unwrap_or("");
    if id.len() != 32 || !id.bytes().all(|b| (b'a'..=b'p').contains(&b)) {
        return Err(ApiError::new(403, "A valid extension origin is required."));
    }
    Ok(origin.into())
}
fn loopback(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Ok(url) = url::Url::parse(&format!("http://{host}")) else {
        return false;
    };
    url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
        && url[url::Position::BeforeHost..url::Position::AfterPort] == *host
}
fn authenticated(db: &Connection, headers: &HeaderMap) -> Result<String> {
    let origin = extension_origin(headers)?;
    let credential = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() == 64)
        .ok_or_else(|| ApiError::new(401, "Pair this extension with Echo."))?;
    db.query_row(
        "SELECT installation_id FROM extension_connections WHERE credential_hash=? AND origin=?",
        params![hash(credential), origin],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| ApiError::new(401, "The extension connection was revoked or is invalid."))
}
fn owned(db: &Connection, headers: &HeaderMap, id: &str) -> Result<Value> {
    let installation = authenticated(db, headers)?;
    let r = recording(db, id)?;
    if r["installationId"] != installation {
        return Err(ApiError::new(
            403,
            "This recording belongs to another installation.",
        ));
    }
    Ok(r)
}
/// Validate origin and host before extractors; expose exact CORS only on this isolated router.
async fn protocol_response(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let json_type = parts
        .headers
        .get(header::CONTENT_TYPE)
        .is_some_and(|v| v.to_str().unwrap_or("").starts_with("application/json"));
    if parts.status.is_client_error() || parts.status.is_server_error() {
        let mut v = if json_type {
            match to_bytes(body, 300_000).await {
                Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                    .unwrap_or(json!({"error":"Invalid response."})),
                Err(_) => json!({"error":"Invalid response."}),
            }
        } else {
            json!({"error":parts.status.canonical_reason().unwrap_or("Invalid request")})
        };
        v["protocolVersion"] = json!(1);
        parts.headers.remove(header::CONTENT_LENGTH);
        parts.headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );
        Response::from_parts(
            parts,
            axum::body::Body::from(serde_json::to_vec(&v).unwrap()),
        )
    } else {
        Response::from_parts(parts, body)
    }
}
async fn protocol(req: Request, next: Next) -> Response {
    protocol_response(next.run(req).await).await
}
async fn access(req: Request, next: Next) -> Response {
    let origin = extension_origin(req.headers());
    if !loopback(req.headers()) || origin.is_err() {
        return reply_error(ApiError::new(
            403,
            "Extension access requires a loopback host and validated origin.",
        ));
    }
    let origin = origin.unwrap();
    let mut response = if req.method() == Method::OPTIONS {
        (StatusCode::NO_CONTENT, "").into_response()
    } else {
        protocol_response(next.run(req).await).await
    };
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_str(&origin).unwrap(),
    );
    response
        .headers_mut()
        .insert(header::VARY, HeaderValue::from_static("Origin"));
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, PUT, POST, DELETE, OPTIONS"),
    );
    response.headers_mut().insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, X-Echo-Frames, X-Echo-SHA256"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
fn reply_error(e: ApiError) -> Response {
    (e.status, reply(json!({"error":e.message}))).into_response()
}
pub fn extension_routes() -> Router {
    Router::new()
        .route("/connection", get(connection).delete(disconnect))
        .route("/pairing/request", post(pair_request))
        .route("/pairing/claim", post(pair_claim))
        .route("/recordings/{id}", put(start).get(status))
        .route("/recordings/{id}/live", get(live_preview))
        .route("/recordings/{id}/chunks/{sequence}", put(chunk))
        .route("/recordings/{id}/complete", post(complete))
        .route("/recordings/{id}/controls/{command}/ack", post(ack))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::from_fn(access))
}
pub fn workspace_routes() -> Router {
    Router::new()
        .route("/extensions/meetings/{id}/audio", get(meeting_audio))
        .route("/extensions/pairing", post(pair_code))
        .route("/extensions/connections", get(connections))
        .route("/extensions/requests/{id}/approve", post(approve))
        .route("/extensions/connections/{id}", delete(revoke))
        .route("/extensions/recordings", get(recordings))
        .route("/extensions/recordings/{id}/controls", post(control))
        .route("/extensions/recordings/{id}/lease", post(lease))
        .route("/extensions/recordings/{id}/live-status", post(live_status))
        .route(
            "/extensions/recordings/{id}/draft",
            post(draft).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/extensions/recordings/{id}/pcm", get(pcm))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(axum::middleware::from_fn(protocol))
}
async fn connection(headers: HeaderMap) -> Result<Json<Value>> {
    store::with_db(|db| {
        let installation = authenticated(db, &headers)?;
        Ok(reply(
            json!({"installationId":installation,"libraryId":library(db)?}),
        ))
    })
}
async fn disconnect(headers: HeaderMap) -> Result<Json<Value>> {
    store::with_db(|db| {
        let installation = authenticated(db, &headers)?;
        db.execute(
            "DELETE FROM extension_connections WHERE installation_id=?",
            [&installation],
        )?;
        Ok(reply(json!({"status":"disconnected"})))
    })
}
async fn pair_code() -> Result<Json<Value>> {
    store::with_db(|db| {
        db.execute("DELETE FROM extension_pairing WHERE expires<?", [seconds()])?;
        let count: i64 =
            db.query_row("SELECT COUNT(*) FROM extension_pairing", [], |r| r.get(0))?;
        if count >= 20 {
            return Err(ApiError::new(429, "Too many active pairing codes."));
        }
        let code = Uuid::new_v4().simple().to_string();
        let expires = seconds() + 300;
        db.execute(
            "INSERT INTO extension_pairing(code_hash,expires,state) VALUES(?,?,'available')",
            params![hash(&code), expires],
        )?;
        Ok(reply(
            json!({"code":code,"expiresAt":expires,"libraryId":library(db)?}),
        ))
    })
}
async fn connections() -> Result<Json<Value>> {
    store::with_db(|db| {
        let mut stmt =
            db.prepare("SELECT installation_id,name,created_at FROM extension_connections")?;
        let connections=stmt.query_map([],|r|Ok(json!({"installationId":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"createdAt":r.get::<_,String>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut stmt=db.prepare("SELECT request_id,installation_id,name,expires FROM extension_pairing WHERE state='pending' AND expires>=?")?;
        let requests=stmt.query_map([seconds()],|r|Ok(json!({"requestId":r.get::<_,String>(0)?,"installationId":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"expiresAt":r.get::<_,i64>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(reply(
            json!({"libraryId":library(db)?,"connections":connections,"requests":requests}),
        ))
    })
}
async fn pair_request(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    fields(&v, &["code", "installationId", "name"])?;
    let code = text(&v, "code", 64)?;
    let installation = text(&v, "installationId", 36)?;
    uid(installation)?;
    let name = text(&v, "name", 120)?;
    let origin = extension_origin(&headers)?;
    store::with_db(|db| {
        let tx = db.transaction()?;
        let row:Option<PairingReservation>=tx.query_row("SELECT expires,request_id,installation_id,origin FROM extension_pairing WHERE code_hash=? AND expires>=?",params![hash(code),seconds()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        let Some((expires, request, old_install, old_origin)) = row else {
            return Err(ApiError::new(403, "Pairing code is invalid or expired."));
        };
        let id = if let Some(request) = request {
            if old_install.as_deref() != Some(installation)
                || old_origin.as_deref() != Some(&origin)
            {
                return Err(ApiError::new(
                    409,
                    "This code already belongs to another pairing request.",
                ));
            }
            request
        } else {
            let id = Uuid::new_v4().to_string();
            tx.execute("UPDATE extension_pairing SET request_id=?,installation_id=?,name=?,origin=?,state='pending' WHERE code_hash=?",params![id,installation,name,origin,hash(code)])?;
            id
        };
        let lib = library(&tx)?;
        tx.commit()?;
        Ok(reply(
            json!({"requestId":id,"libraryId":lib,"expiresAt":expires}),
        ))
    })
}
async fn approve(Path(id): Path<String>) -> Result<Json<Value>> {
    uid(&id)?;
    store::with_db(|db| {
        let n=db.execute("UPDATE extension_pairing SET state='approved' WHERE request_id=? AND state='pending' AND expires>=?",params![id,seconds()])?;
        if n == 0 {
            return Err(ApiError::new(
                409,
                "Pairing request is unavailable or already approved.",
            ));
        }
        Ok(reply(json!({"status":"approved"})))
    })
}
async fn pair_claim(headers: HeaderMap, Json(v): Json<Value>) -> Result<Json<Value>> {
    fields(&v, &["requestId", "installationId", "code"])?;
    let request = text(&v, "requestId", 36)?;
    let install = text(&v, "installationId", 36)?;
    uid(request)?;
    uid(install)?;
    let code = text(&v, "code", 64)?;
    let origin = extension_origin(&headers)?;
    store::with_db(|db| {
        let tx = db.transaction()?;
        let row:Option<(String,String)>=tx.query_row("SELECT state,name FROM extension_pairing WHERE request_id=? AND installation_id=? AND code_hash=? AND origin=? AND expires>=?",params![request,install,hash(code),origin,seconds()],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
        let Some((state, name)) = row else {
            return Err(ApiError::new(403, "Pairing request is invalid or expired."));
        };
        if state == "pending" {
            return Ok(reply(json!({"status":"pending"})));
        }
        let lib = library(&tx)?;
        let credential = hash(format!(
            "echo-extension-v1\0{code}\0{request}\0{install}\0{lib}"
        ));
        if state == "claimed" {
            let present:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM extension_connections WHERE installation_id=? AND credential_hash=? AND origin=?)",params![install,hash(&credential),origin],|r|r.get(0))?;
            if !present {
                return Err(ApiError::new(
                    403,
                    "Connection was revoked; create a new pairing code.",
                ));
            }
        } else if state == "approved" {
            tx.execute("INSERT INTO extension_connections VALUES(?,?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET name=excluded.name,origin=excluded.origin,credential_hash=excluded.credential_hash,created_at=excluded.created_at",params![install,name,origin,hash(&credential),store::now()])?;
            tx.execute(
                "UPDATE extension_pairing SET state='claimed' WHERE request_id=?",
                [request],
            )?;
        } else {
            return Err(ApiError::new(403, "Pairing is unavailable."));
        }
        tx.commit()?;
        Ok(reply(
            json!({"status":"approved","credential":credential,"libraryId":lib}),
        ))
    })
}
async fn revoke(Path(id): Path<String>) -> Result<Json<Value>> {
    uid(&id)?;
    store::with_db(|db| {
        db.execute(
            "DELETE FROM extension_connections WHERE installation_id=?",
            [id],
        )?;
        Ok(reply(json!({"status":"revoked"})))
    })
}
async fn start(
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> Result<Json<Value>> {
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
    store::with_db(|db| {
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
            return Ok(reply(extension_recording(r, &lib)));
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
        Ok(reply(extension_recording(r, &lib)))
    })
}
fn verify_complete_files(db: &Connection, r: &Value) -> Result<()> {
    if r["status"] != "complete" {
        return Ok(());
    }
    let meeting_id = r["meetingId"].as_str().unwrap();
    let meeting = store::require_meeting(db, meeting_id)?;
    store::validate_meeting(&meeting)?;
    let mut stmt = db.prepare("SELECT file,bytes FROM audio_chunks WHERE meeting_id=?")?;
    let rows = stmt
        .query_map([meeting_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let expected = meeting["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["bytes"].as_u64().unwrap())
        .sum::<u64>();
    if rows.iter().map(|row| row.1).sum::<u64>() != expected || rows.is_empty() {
        return Err(ApiError::new(410, "The completed audio index is incomplete. Keep your local recording and restore Echo audio."));
    }
    for (file, bytes) in rows {
        if std::path::Path::new(&file)
            .file_name()
            .and_then(|s| s.to_str())
            != Some(file.as_str())
        {
            return Err(ApiError::new(410, "Invalid completed audio reference."));
        }
        let path = store::data_dir().join("audio").join(meeting_id).join(file);
        let metadata = fs::symlink_metadata(path).map_err(|_| {
            ApiError::new(
                410,
                "Completed audio is missing. Keep your local recording and restore Echo audio.",
            )
        })?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() != bytes {
            return Err(ApiError::new(
                410,
                "Completed audio is damaged. Keep your local recording and restore Echo audio.",
            ));
        }
    }
    Ok(())
}
async fn status(Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>> {
    store::with_db(|db| {
        let r = owned(db, &headers, &id)?;
        verify_complete_files(db, &r)?;
        Ok(reply(extension_recording(r, &library(db)?)))
    })
}
/// Only a short draft tail is exposed to the recording's authenticated installation.
async fn live_preview(Path(id): Path<String>, headers: HeaderMap) -> Result<Json<Value>> {
    store::with_db(|db| {
        let r = owned(db, &headers, &id)?;
        if r["status"] == "deleted" {
            return Err(ApiError::new(410, "Recording was deleted."));
        }
        let meeting = store::require_meeting(db, r["meetingId"].as_str().unwrap())?;
        Ok(reply(live_snapshot(&r, &meeting, &library(db)?, seconds())))
    })
}
fn live_snapshot(r: &Value, meeting: &Value, lib: &str, now: i64) -> Value {
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
async fn live_status(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
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
    store::with_db(|db| {
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
}
fn pcm_dir(id: &str) -> PathBuf {
    store::data_dir().join("extension-pcm").join(id)
}
#[cfg(test)]
#[derive(Default)]
struct SyncFault {
    path: PathBuf,
    failures_remaining: usize,
    calls: usize,
}
#[cfg(test)]
static SYNC_FAULT: std::sync::Mutex<Option<SyncFault>> = std::sync::Mutex::new(None);
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
fn chunk_path(id: &str, file: &str) -> Result<PathBuf> {
    if std::path::Path::new(file)
        .file_name()
        .and_then(|s| s.to_str())
        != Some(file)
    {
        return Err(ApiError::new(410, "Invalid saved PCM reference."));
    }
    Ok(pcm_dir(id).join(file))
}
fn read_chunk(path: &std::path::Path, frames: u64, digest: &str) -> Result<Vec<u8>> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(ApiError::new(410, "A saved audio chunk is unsafe."));
    }
    let data = fs::read(path)?;
    if data.len() as u64 != frames * 2 || hash(&data) != digest {
        return Err(ApiError::new(
            410,
            "A saved audio chunk is missing or damaged.",
        ));
    }
    Ok(data)
}
async fn chunk(
    Path((id, sequence)): Path<(String, u64)>,
    headers: HeaderMap,
    data: Bytes,
) -> Result<Json<Value>> {
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
    store::with_db(|db| {
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
            sync_audio(&path, &pcm_dir(&id))?;
            return Ok(reply(extension_recording(r, &library(&tx)?)));
        }
        if r["status"] != "receiving" || r["nextSequence"].as_u64() != Some(sequence) {
            return Err(ApiError::new(
                409,
                "Send the missing chunk before continuing.",
            ));
        }
        let total = r["totalFrames"].as_u64().unwrap() + frames;
        if total > MAX_FRAMES {
            return Err(ApiError::new(413, "Recording reached eight hours."));
        }
        let dir = pcm_dir(&id);
        store::mkdir(&dir)?;
        synced_directory(dir.parent().unwrap())?;
        synced_directory(&store::data_dir())?;
        let file = format!("{sequence}-{digest}.pcm");
        let path = dir.join(&file);
        if path.exists() && fs::symlink_metadata(&path)?.file_type().is_symlink() {
            return Err(ApiError::new(410, "Unsafe PCM file."));
        }
        if !path.exists() || read_chunk(&path, frames, digest).is_err() {
            if path.exists() {
                fs::remove_file(&path)?;
            }
            store::write_private(&path, &data)?;
        }
        sync_audio(&path, &dir)?;
        tx.execute(
            "INSERT INTO extension_chunks VALUES(?,?,?,?,?)",
            params![id, sequence, frames, digest, file],
        )?;
        r["nextSequence"] = json!(sequence + 1);
        r["totalFrames"] = json!(total);
        save_recording(&tx, &r)?;
        let mut meeting = store::require_meeting(&tx, r["meetingId"].as_str().unwrap())?;
        meeting["duration"] = json!(total as f64 / RATE as f64);
        meeting["extensionRecording"]["totalFrames"] = json!(total);
        store::save(&tx, &mut meeting)?;
        let lib = library(&tx)?;
        tx.commit()?;
        Ok(reply(extension_recording(r, &lib)))
    })
}
fn wav_header(frames: u64) -> Vec<u8> {
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
struct Completion {
    chunk_count: u64,
    total_frames: u64,
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
async fn complete(
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
    store::with_db(|db| {
        let tx = db.transaction()?;
        let mut r = owned(&tx, &headers, &id)?;
        let lib = library(&tx)?;
        if r["status"] == "deleted" {
            return Ok(reply(extension_recording(r, &lib)));
        }
        if r["status"] == "complete" {
            verify_complete_files(&tx, &r)?;
            if r["manifest"] != manifest {
                return Err(ApiError::new(409, "Completion manifest conflicts."));
            }
            return Ok(reply(extension_recording(r, &lib)));
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
        let meeting_id = r["meetingId"].as_str().unwrap();
        let mut meeting = store::require_meeting(&tx, meeting_id)?;
        let dir = store::data_dir().join("audio").join(meeting_id);
        store::mkdir(&dir)?;
        synced_directory(dir.parent().unwrap())?;
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
            if !path.exists() || hash(fs::read(&path)?) != digest {
                if path.exists() {
                    fs::remove_file(&path)?;
                }
                store::write_private(&path, &wav)?;
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
        meeting.as_object_mut().unwrap().remove("error");
        meeting["duration"] = json!(input.total_frames as f64 / RATE as f64);
        meeting["gaps"]=json!(input.gaps.iter().map(|g|json!({"start":g.at_frame as f64/RATE as f64,"end":g.at_frame as f64/RATE as f64,"reason":format!("Recording paused for {} ms",g.pause_ms)})).collect::<Vec<_>>());
        store::validate_meeting(&meeting)?;
        store::save(&tx, &mut meeting)?;
        r["status"] = json!("complete");
        r["manifest"] = manifest;
        r["generation"] = json!(r["generation"].as_u64().unwrap_or(0) + 1);
        r.as_object_mut().unwrap().remove("lease");
        save_recording(&tx, &r)?;
        tx.commit()?;
        Ok(reply(extension_recording(r, &lib)))
    })
}
async fn recordings() -> Result<Json<Value>> {
    store::with_db(|db| {
        let lib = library(db)?;
        let mut stmt = db.prepare("SELECT data FROM extension_recordings")?;
        let values = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|r| Ok(public_recording(serde_json::from_str(&r)?, &lib)))
            .collect::<Result<Vec<_>>>()?;
        Ok(reply(json!({"libraryId":lib,"recordings":values})))
    })
}
async fn control(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
    fields(&v, &["action", "commandId"])?;
    let action = text(&v, "action", 10)?;
    if !matches!(action, "pause" | "resume" | "stop") {
        return Err(ApiError::bad("Unsupported recording control."));
    }
    let command = text(&v, "commandId", 36)?;
    uid(command)?;
    store::with_db(|db| {
        let mut r = recording(db, &id)?;
        if r["status"] != "receiving" {
            return Err(ApiError::new(409, "Recording is no longer receiving."));
        }
        if let Some(old) = r["controlHistory"].get(command) {
            if old != action {
                return Err(ApiError::new(409, "Control command conflicts."));
            }
        } else {
            if r["controls"].as_array().unwrap().len() >= 100
                || r["controlHistory"].as_object().unwrap().len() >= 10000
            {
                return Err(ApiError::new(429, "Too many controls."));
            }
            r["controlHistory"][command] = json!(action);
            r["controls"]
                .as_array_mut()
                .unwrap()
                .push(json!({"commandId":command,"action":action}));
        }
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"queued"})))
    })
}
async fn ack(
    Path((id, command)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    uid(&command)?;
    store::with_db(|db| {
        let mut r = owned(db, &headers, &id)?;
        r["controls"]
            .as_array_mut()
            .unwrap()
            .retain(|c| c["commandId"] != command);
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"acknowledged"})))
    })
}
async fn lease(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
    fields(&v, &["ownerId"])?;
    let owner = text(&v, "ownerId", 100)?;
    store::with_db(|db| {
        let mut r = recording(db, &id)?;
        let meeting = store::require_meeting(db, r["meetingId"].as_str().unwrap())?;
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
    })
}
/// Preserve prior temporal ownership; newly owned overlapping words may sort before old words.
fn committed_words_match(old: &Value, submitted: &[Value]) -> bool {
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
            word["startFrame"].as_u64().unwrap() + word["endFrame"].as_u64().unwrap()
                <= 2 * previous
        })
        .collect();
    stable == prior_owned
}
async fn draft(Path(id): Path<String>, Json(v): Json<Value>) -> Result<Json<Value>> {
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
    store::with_db(|db| {
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
        if through > r["totalFrames"].as_u64().unwrap()
            || through < r["draft"]["throughFrame"].as_u64().unwrap_or(0)
            || committed < r["draft"]["committedThroughFrame"].as_u64().unwrap_or(0)
        {
            return Err(ApiError::new(
                409,
                "Draft cursor is outside saved audio or moved backwards.",
            ));
        }
        if !committed_words_match(&r["draft"], v["words"].as_array().unwrap()) {
            return Err(ApiError::new(
                409,
                "Committed live words cannot be replaced.",
            ));
        }
        let mut saved = v;
        saved.as_object_mut().unwrap().remove("ownerId");
        saved.as_object_mut().unwrap().remove("generation");
        r["draft"] = saved;
        save_recording(db, &r)?;
        Ok(reply(json!({"status":"saved"})))
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PcmQuery {
    start_frame: u64,
    frame_count: u64,
}
async fn pcm(Path(id): Path<String>, Query(q): Query<PcmQuery>) -> Result<Response> {
    if q.frame_count == 0 || q.frame_count > RATE * 20 {
        return Err(ApiError::bad("Request at most 20 seconds of PCM."));
    }
    let data = store::with_db(|db| {
        let r = recording(db, &id)?;
        if r["status"] == "deleted" {
            return Err(ApiError::new(410, "Recording was deleted."));
        }
        let end = q
            .start_frame
            .checked_add(q.frame_count)
            .filter(|n| *n <= r["totalFrames"].as_u64().unwrap())
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
    })?;
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
async fn meeting_audio(
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Response> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let meeting = store::get_meeting(&id)?.ok_or_else(ApiError::not_found)?;
    let metadata = meeting
        .get("extensionRecording")
        .ok_or_else(ApiError::not_found)?;
    validate_metadata(metadata)?;
    let frames = metadata["totalFrames"].as_u64().unwrap();
    let total = 44 + frames * 2;
    let header_bytes = wav_header(frames);
    let mut sources = Vec::new();
    for track in metadata["partTrackIds"].as_array().unwrap() {
        let (_, parts) = store::get_audio_parts(&id, track.as_str().unwrap())?;
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
    let (start, end, partial) = match audio_range(
        headers.get(header::RANGE).and_then(|h| h.to_str().ok()),
        total,
    ) {
        Ok(v) => v,
        Err(error) => {
            let mut response = reply_error(error);
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{total}").parse().unwrap(),
            );
            return Ok(response);
        }
    };
    let stream = async_stream::stream! {if start<44{yield Ok::<Vec<u8>,std::io::Error>(header_bytes[start as usize..(end+1).min(44)as usize].to_vec());}let mut offset=44;for (path,skip,size) in sources{let part_start=offset;let part_end=offset+size;offset=part_end;if part_end<=start||part_start>end{continue;}let from=start.saturating_sub(part_start);let until=(end+1).min(part_end)-part_start;let mut remaining=until-from;let mut file=match tokio::fs::File::open(path).await{Ok(f)=>f,Err(e)=>{yield Err(e);return;}};if let Err(e)=file.seek(std::io::SeekFrom::Start(skip+from)).await{yield Err(e);return;}while remaining>0{let mut buffer=vec![0u8;remaining.min(65536)as usize];match file.read(&mut buffer).await{Ok(0)=>{yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof,"Saved WAV is incomplete."));return;},Ok(n)=>{remaining-=n as u64;buffer.truncate(n);yield Ok(buffer);},Err(e)=>{yield Err(e);return;}}}}};
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
fn audio_range(value: Option<&str>, size: u64) -> Result<(u64, u64, bool)> {
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
pub(crate) fn cleanup_pcm(db: &Connection, meeting: &str) -> Result<()> {
    let id: Option<String> = db
        .query_row(
            "SELECT recording_id FROM extension_recordings WHERE meeting_id=?",
            [meeting],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = id {
        uid(&id)?;
        let dir = pcm_dir(&id);
        if dir.exists() {
            fs::remove_dir_all(dir)?;
        }
    }
    Ok(())
}
/// Portable receipts exclude pairing codes and credentials. Pending PCM needs a whole-folder backup.
pub(crate) fn backup_receipts(db: &Connection) -> Result<Vec<Value>> {
    let mut stmt = db.prepare("SELECT data FROM extension_recordings")?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut receipts = vec![];
    for raw in rows {
        let r: Value = serde_json::from_str(&raw)?;
        if r["status"] == "receiving" {
            return Err(ApiError::new(409,"Synchronize pending extension recordings before a browser backup, or stop Echo and copy the entire data folder."));
        }
        let mut receipt = json!({"recordingId":r["recordingId"],"installationId":r["installationId"],"meetingId":r["meetingId"],"status":r["status"],"totalFrames":r["totalFrames"],"nextSequence":r["nextSequence"],"liveTranscription":r["liveTranscription"]});
        if let Some(manifest) = r.get("manifest") {
            receipt["manifest"] = manifest.clone();
        }
        receipts.push(receipt);
    }
    Ok(receipts)
}
pub(crate) fn validate_receipts(receipts: &Value, meetings: &[Value]) -> Result<Vec<Value>> {
    let rows = receipts
        .as_array()
        .filter(|r| r.len() <= 10000)
        .ok_or_else(|| ApiError::bad("Invalid recording receipts."))?;
    let mut seen = std::collections::HashSet::new();
    let mut mapped = std::collections::HashSet::new();
    for r in rows {
        fields(
            r,
            &[
                "recordingId",
                "installationId",
                "meetingId",
                "status",
                "totalFrames",
                "nextSequence",
                "liveTranscription",
                "manifest",
                "draft",
            ],
        )?;
        for key in ["recordingId", "installationId", "meetingId"] {
            uid(text(r, key, 36)?)?;
        }
        if !seen.insert(text(r, "recordingId", 36)?) || !mapped.insert(text(r, "meetingId", 36)?) {
            return Err(ApiError::bad("Duplicate recording receipt."));
        }
        if !matches!(r["status"].as_str(), Some("complete" | "deleted"))
            || r["totalFrames"].as_u64().is_none_or(|n| n > MAX_FRAMES)
            || r["nextSequence"].as_u64().is_none_or(|n| n > MAX_FRAMES)
            || !r["liveTranscription"].is_boolean()
        {
            return Err(ApiError::bad("Invalid recording receipt fields."));
        }
        let meeting = meetings.iter().find(|m| m["id"] == r["meetingId"]);
        if r["status"] == "deleted" && meeting.is_some()
            || r["status"] == "complete"
                && meeting.is_none_or(|m| {
                    m["extensionRecording"]["recordingId"] != r["recordingId"]
                        || m["extensionRecording"]["installationId"] != r["installationId"]
                        || m["extensionRecording"]["totalFrames"] != r["totalFrames"]
                })
        {
            return Err(ApiError::bad(
                "Recording receipt does not match its meeting.",
            ));
        }
        if let Some(manifest) = r.get("manifest") {
            let c: Completion = serde_json::from_value(manifest.clone())?;
            if c.chunk_count != r["nextSequence"] || c.total_frames != r["totalFrames"] {
                return Err(ApiError::bad("Receipt manifest is inconsistent."));
            }
        }
        if r.get("draft").is_some() {
            return Err(ApiError::bad("Live drafts are private workspace state; finish processing before portable backup."));
        }
    }
    for meeting in meetings {
        if let Some(metadata) = meeting.get("extensionRecording") {
            if !rows.iter().any(|r| {
                r["recordingId"] == metadata["recordingId"]
                    && r["meetingId"] == meeting["id"]
                    && r["status"] == "complete"
            }) {
                return Err(ApiError::bad(
                    "An extension meeting is missing its completion receipt.",
                ));
            }
        }
    }
    Ok(rows.clone())
}
pub(crate) fn restore_receipts(db: &Connection, receipts: &[Value]) -> Result<()> {
    for receipt in receipts {
        let id = text(receipt, "recordingId", 36)?;
        let existing: Option<String> = db
            .query_row(
                "SELECT data FROM extension_recordings WHERE recording_id=?",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(old) = existing {
            let old: Value = serde_json::from_str(&old)?;
            if old["status"] == "deleted" && receipt["status"] == "complete" {
                return Err(ApiError::new(409,"This recording was deleted from this library. Restore into a separate empty data folder."));
            }
            if old["meetingId"] != receipt["meetingId"] {
                return Err(ApiError::new(
                    409,
                    "Recording receipt conflicts with this library.",
                ));
            }
        }
        let mut r = receipt.clone();
        r["controls"] = json!([]);
        r["controlHistory"] = json!({});
        r["generation"] = json!(0);
        db.execute("INSERT INTO extension_recordings VALUES(?,?,?,?) ON CONFLICT(recording_id) DO UPDATE SET data=excluded.data",params![id,receipt["installationId"].as_str(),receipt["meetingId"].as_str(),r.to_string()])?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use tower::ServiceExt;
    const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    fn app() -> Router {
        Router::new()
            .nest(
                "/api",
                workspace_routes().layer(axum::middleware::from_fn(crate::security::local_access)),
            )
            .nest("/extension/v1", extension_routes())
    }
    async fn send(
        app: &Router,
        method: &str,
        path: &str,
        origin: &str,
        credential: Option<&str>,
        body: Vec<u8>,
        extra: &[(&str, String)],
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut req = Request::builder()
            .method(method)
            .uri(path)
            .header("host", "localhost:3000")
            .header("origin", origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = credential {
            req = req.header(header::AUTHORIZATION, format!("Bearer {c}"));
        }
        for (k, v) in extra {
            req = req.header(*k, v);
        }
        let response = app
            .clone()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = to_bytes(response.into_body(), 16 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }
    async fn json_request(
        app: &Router,
        method: &str,
        path: &str,
        origin: &str,
        credential: Option<&str>,
        value: Value,
    ) -> (StatusCode, Value) {
        let (status, _, bytes) = send(
            app,
            method,
            path,
            origin,
            credential,
            serde_json::to_vec(&value).unwrap(),
            &[],
        )
        .await;
        let v: Value = serde_json::from_slice(&bytes).unwrap_or_else(|_| {
            panic!("non-JSON {} {:?}", status, String::from_utf8_lossy(&bytes))
        });
        if path.starts_with("/extension/") || status.is_success() {
            assert_eq!(v["protocolVersion"], 1);
        }
        (status, v)
    }
    async fn pair(app: &Router, installation: &str) -> (String, String, String) {
        let (_, code) = json_request(
            app,
            "POST",
            "/api/extensions/pairing",
            "http://localhost:3000",
            None,
            json!({}),
        )
        .await;
        let request =
            json!({"code":code["code"],"installationId":installation,"name":"Test browser"});
        let (status, pending) = json_request(
            app,
            "POST",
            "/extension/v1/pairing/request",
            ORIGIN,
            None,
            request,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let claim = json!({"code":code["code"],"installationId":installation,"requestId":pending["requestId"]});
        let (_, v) = json_request(
            app,
            "POST",
            "/extension/v1/pairing/claim",
            ORIGIN,
            None,
            claim.clone(),
        )
        .await;
        assert_eq!(v["status"], "pending");
        let id = pending["requestId"].as_str().unwrap();
        let (status, _) = json_request(
            app,
            "POST",
            &format!("/api/extensions/requests/{id}/approve"),
            "http://localhost:3000",
            None,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, claimed) = json_request(
            app,
            "POST",
            "/extension/v1/pairing/claim",
            ORIGIN,
            None,
            claim.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (_, retry) = json_request(
            app,
            "POST",
            "/extension/v1/pairing/claim",
            ORIGIN,
            None,
            claim,
        )
        .await;
        assert_eq!(retry["credential"], claimed["credential"]);
        (
            claimed["credential"].as_str().unwrap().into(),
            code["code"].as_str().unwrap().into(),
            id.into(),
        )
    }
    fn input() -> Value {
        json!({"title":"Extension test","provider":"meet","meetingUrl":"https://meet.google.com/aaa-bbbb-ccc","consent":true,"liveTranscription":true,"sampleRate":16000,"channels":1,"createdAt":"2026-10-05T12:00:00Z"})
    }
    #[test]
    fn live_status_snapshot_bounds_preview_and_expires_heartbeats() {
        let mut r = json!({"recordingId":"r","meetingId":"m","status":"receiving","liveTranscription":true,"generation":2,"totalFrames":640000,
            "draft":{"throughFrame":320000,"committedThroughFrame":280000,"words":[{"text":"é".repeat(1000),"provisional":true}]},
            "liveStatus":{"status":"catching-up","updatedAt":100,"generation":2}});
        let current = live_snapshot(&r, &json!({}), "library", 110);
        assert_eq!(current["status"], "catching-up");
        assert_eq!(current["preview"].as_str().unwrap().chars().count(), 600);
        assert_eq!(current["backlogSeconds"], 20.0);
        assert_eq!(
            live_snapshot(&r, &json!({}), "library", 115)["status"],
            "paused-open-echo"
        );
        r["generation"] = json!(3);
        assert_eq!(
            live_snapshot(&r, &json!({}), "library", 110)["status"],
            "paused-open-echo"
        );
        r["status"] = json!("complete");
        assert_eq!(
            live_snapshot(&r, &json!({}), "library", 110)["status"],
            "final-transcript-needed"
        );
        // Missing models, cancellation and processing failures leave saved audio ready for retry.
        for meeting in [
            json!({"status":"saved"}),
            json!({"status":"saved","error":"Cancelled"}),
            json!({"status":"error","error":"Model unavailable"}),
        ] {
            assert_eq!(
                live_snapshot(&r, &meeting, "library", 110)["status"],
                "final-transcript-needed"
            );
        }
        assert_eq!(
            live_snapshot(&r, &json!({"status":"processing"}), "library", 110)["status"],
            "finalizing"
        );
        assert_eq!(
            live_snapshot(&r, &json!({"transcripts":[{}]}), "library", 110)["status"],
            "complete"
        );
    }
    #[tokio::test]
    async fn live_preview_ownership_status_fencing_and_connection_revocation() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::init().unwrap();
        let app = app();
        let first = Uuid::new_v4().to_string();
        let second = Uuid::new_v4().to_string();
        let (token, _, _) = pair(&app, &first).await;
        let (other, _, _) = pair(&app, &second).await;
        let id = Uuid::new_v4().to_string();
        let (code, _) = json_request(
            &app,
            "PUT",
            &format!("/extension/v1/recordings/{id}"),
            ORIGIN,
            Some(&token),
            input(),
        )
        .await;
        assert_eq!(code, StatusCode::OK);
        let path = format!("/extension/v1/recordings/{id}/live");
        let (code, preview) =
            json_request(&app, "GET", &path, ORIGIN, Some(&token), json!(null)).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(preview["status"], "paused-open-echo");
        assert!(preview.get("draft").is_none());
        for (credential, expected) in [
            (Some(other.as_str()), StatusCode::FORBIDDEN),
            (None, StatusCode::UNAUTHORIZED),
        ] {
            assert_eq!(
                json_request(&app, "GET", &path, ORIGIN, credential, json!(null))
                    .await
                    .0,
                expected
            );
        }
        assert_eq!(
            json_request(
                &app,
                "GET",
                &format!("/extension/v1/recordings/{}/live", Uuid::new_v4()),
                ORIGIN,
                Some(&token),
                json!(null)
            )
            .await
            .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            json_request(
                &app,
                "GET",
                &path,
                "https://hostile.example",
                Some(&token),
                json!(null)
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let report = format!("/api/extensions/recordings/{id}/live-status");
        assert_eq!(
            json_request(
                &app,
                "POST",
                &report,
                "http://localhost:3000",
                None,
                json!({"ownerId":"a","generation":0,"status":"model-missing"})
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            json_request(&app, "GET", &path, ORIGIN, Some(&token), json!(null))
                .await
                .1["status"],
            "model-missing"
        );
        let (_, lease) = json_request(
            &app,
            "POST",
            &format!("/api/extensions/recordings/{id}/lease"),
            "http://localhost:3000",
            None,
            json!({"ownerId":"a"}),
        )
        .await;
        for (owner, generation, expected) in [
            ("b", lease["generation"].clone(), StatusCode::CONFLICT),
            ("a", json!(0), StatusCode::CONFLICT),
            ("a", lease["generation"].clone(), StatusCode::OK),
        ] {
            assert_eq!(
                json_request(
                    &app,
                    "POST",
                    &report,
                    "http://localhost:3000",
                    None,
                    json!({"ownerId":owner,"generation":generation,"status":"live"})
                )
                .await
                .0,
                expected
            );
        }
        assert_eq!(
            json_request(
                &app,
                "POST",
                &report,
                ORIGIN,
                Some(&token),
                json!({"ownerId":"a","generation":lease["generation"],"status":"live"})
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
        let (_, connection) = json_request(
            &app,
            "GET",
            "/extension/v1/connection",
            ORIGIN,
            Some(&token),
            json!(null),
        )
        .await;
        assert_eq!(connection["installationId"], first);
        assert!(connection.get("credential").is_none());
        assert_eq!(
            json_request(
                &app,
                "DELETE",
                "/extension/v1/connection",
                ORIGIN,
                Some(&token),
                json!(null)
            )
            .await
            .0,
            StatusCode::OK
        );
        assert_eq!(
            json_request(&app, "GET", &path, ORIGIN, Some(&token), json!(null))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            json_request(
                &app,
                "GET",
                "/extension/v1/connection",
                ORIGIN,
                Some(&other),
                json!(null)
            )
            .await
            .0,
            StatusCode::OK
        );
        store::reset_for_tests();
    }
    #[tokio::test]
    async fn pairing_durable_ingest_security_replay_recovery_tombstones_and_leases() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::init().unwrap();
        store::with_db(|db| {
            assert_eq!(
                db.query_row("PRAGMA synchronous", [], |row| row.get::<_, i64>(0))?,
                2
            );
            Ok(())
        })
        .unwrap();
        let app = app();
        let install = Uuid::new_v4().to_string();
        let (token, code, request) = pair(&app, &install).await;
        // Credentials and pairing secrets are never persisted verbatim.
        store::with_db(|db| {
            let saved: String = db.query_row(
                "SELECT credential_hash FROM extension_connections",
                [],
                |r| r.get(0),
            )?;
            assert_eq!(saved, hash(&token));
            let saved: String =
                db.query_row("SELECT code_hash FROM extension_pairing", [], |r| r.get(0))?;
            assert_eq!(saved, hash(&code));
            Ok(())
        })
        .unwrap();
        for origin in [
            "https://hostile.example",
            "null",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
            "chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        ] {
            let (status, _, _) = send(
                &app,
                "GET",
                "/extension/v1/recordings/unknown",
                origin,
                Some(&token),
                vec![],
                &[],
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
        }
        for host in [
            "attacker.example",
            "localhost:3000@attacker.example",
            "localhost:3000/evil",
            "127.0.0.1:3000?evil",
            "localhost:bad",
        ] {
            assert!(!loopback(&HeaderMap::from_iter([(
                header::HOST,
                HeaderValue::from_str(host).unwrap()
            )])));
        }
        let (status, _) = json_request(
            &app,
            "GET",
            "/api/extensions/connections",
            ORIGIN,
            Some(&token),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, headers, _) = send(
            &app,
            "OPTIONS",
            "/extension/v1/recordings/id",
            ORIGIN,
            None,
            vec![],
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert_eq!(headers[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        let claim = json!({"code":code,"requestId":request,"installationId":install});
        let (status, _) = json_request(
            &app,
            "POST",
            "/extension/v1/pairing/claim",
            "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            None,
            claim.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = json_request(
            &app,
            "POST",
            "/extension/v1/pairing/request",
            ORIGIN,
            None,
            json!({"code":code,"installationId":Uuid::new_v4().to_string(),"name":"Other"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let id = Uuid::new_v4().to_string();
        let path = format!("/extension/v1/recordings/{id}");
        let (status, r) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
        assert_eq!(status, StatusCode::OK);
        let meeting = r["meetingId"].as_str().unwrap().to_string();
        let (_, retry) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
        assert_eq!(retry["meetingId"], meeting);
        let mut no_consent = input();
        no_consent["consent"] = json!(false);
        let (status, _) = json_request(
            &app,
            "PUT",
            &format!("/extension/v1/recordings/{}", Uuid::new_v4()),
            ORIGIN,
            Some(&token),
            no_consent,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let mut conflict = input();
        conflict["title"] = json!("Changed");
        let (status, _) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), conflict).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let other = Uuid::new_v4().to_string();
        let (other_token, _, _) = pair(&app, &other).await;
        let (status, _) =
            json_request(&app, "GET", &path, ORIGIN, Some(&other_token), json!({})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let data = vec![1, 0, 2, 0, 3, 0, 4, 0];
        let extra = [
            ("x-echo-frames", "4".into()),
            ("x-echo-sha256", hash(&data)),
        ];
        let chunk_path = format!("{path}/chunks/0");
        let (status, _, _) = send(
            &app,
            "PUT",
            &format!("{path}/chunks/1"),
            ORIGIN,
            Some(&token),
            data.clone(),
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        // Repair a file left partially written before a durable manifest commit.
        store::mkdir(&pcm_dir(&id)).unwrap();
        fs::write(pcm_dir(&id).join(format!("0-{}.pcm", hash(&data))), [1]).unwrap();
        let (status, _, _) = send(
            &app,
            "PUT",
            &chunk_path,
            ORIGIN,
            Some(&token),
            data.clone(),
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _, _) = send(
            &app,
            "PUT",
            &chunk_path,
            ORIGIN,
            Some(&token),
            data.clone(),
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let changed = vec![5, 0, 2, 0, 3, 0, 4, 0];
        let changed_extra = [
            ("x-echo-frames", "4".into()),
            ("x-echo-sha256", hash(&changed)),
        ];
        let (status, _, _) = send(
            &app,
            "PUT",
            &chunk_path,
            ORIGIN,
            Some(&token),
            changed,
            &changed_extra,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _, _) = send(
            &app,
            "PUT",
            &chunk_path,
            ORIGIN,
            Some(&token),
            vec![1],
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let status_path = format!("/api/extensions/recordings/{id}");
        let (_, first) = json_request(
            &app,
            "POST",
            &format!("{status_path}/lease"),
            "http://localhost:3000",
            None,
            json!({"ownerId":"tab1"}),
        )
        .await;
        let (_, renew) = json_request(
            &app,
            "POST",
            &format!("{status_path}/lease"),
            "http://localhost:3000",
            None,
            json!({"ownerId":"tab1"}),
        )
        .await;
        assert_eq!(first["generation"], renew["generation"]);
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/lease"),
            "http://localhost:3000",
            None,
            json!({"ownerId":"tab2"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let draft = json!({"ownerId":"tab1","generation":first["generation"],"throughFrame":4,"committedThroughFrame":2,"words":[{"text":"Hi","startFrame":0,"endFrame":4,"provisional":false},{"text":"tail","startFrame":1,"endFrame":4,"provisional":true}],"language":"en","modelRevision":"large-v3"});
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/draft"),
            "http://localhost:3000",
            None,
            draft.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mut changed_committed = draft.clone();
        changed_committed["words"][0]["text"] = json!("Changed committed word");
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/draft"),
            "http://localhost:3000",
            None,
            changed_committed,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let mut overflow = draft.clone();
        overflow["throughFrame"] = json!(u64::MAX);
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/draft"),
            "http://localhost:3000",
            None,
            overflow,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        store::with_db(|db| {
            let mut r = recording(db, &id)?;
            r["lease"]["expiresAt"] = json!(seconds() - 1);
            save_recording(db, &r)
        })
        .unwrap();
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/draft"),
            "http://localhost:3000",
            None,
            draft.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (_, second) = json_request(
            &app,
            "POST",
            &format!("{status_path}/lease"),
            "http://localhost:3000",
            None,
            json!({"ownerId":"tab2"}),
        )
        .await;
        assert!(second["generation"].as_u64().unwrap() > first["generation"].as_u64().unwrap());
        assert_eq!(second["totalFrames"], 4);
        assert_eq!(second["draft"]["throughFrame"], 4);
        assert_eq!(second["draft"]["words"], draft["words"]);
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/draft"),
            "http://localhost:3000",
            None,
            draft.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _, bytes) = send(
            &app,
            "GET",
            &format!("{status_path}/pcm?startFrame=1&frameCount=2"),
            "http://localhost:3000",
            None,
            vec![],
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(bytes, data[2..6]);
        let (status, _, _) = send(
            &app,
            "GET",
            &format!("{status_path}/pcm?startFrame=0&frameCount=320001"),
            "http://localhost:3000",
            None,
            vec![],
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let command = Uuid::new_v4().to_string();
        let control = json!({"commandId":command,"action":"pause"});
        for _ in 0..2 {
            let (status, _) = json_request(
                &app,
                "POST",
                &format!("{status_path}/controls"),
                "http://localhost:3000",
                None,
                control.clone(),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
        }
        let (_, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
        assert_eq!(r["controls"].as_array().unwrap().len(), 1);
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{path}/controls/{command}/ack"),
            ORIGIN,
            Some(&token),
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        json_request(
            &app,
            "POST",
            &format!("{status_path}/controls"),
            "http://localhost:3000",
            None,
            control,
        )
        .await;
        let (_, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
        assert!(r["controls"].as_array().unwrap().is_empty());
        // Restart retains the credential and manifest while durable upload retries keep the mapping.
        store::reset_for_tests();
        store::init().unwrap();
        let (status, claimed) = json_request(
            &app,
            "POST",
            "/extension/v1/pairing/claim",
            ORIGIN,
            None,
            claim.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(claimed["credential"], token);
        let (status, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(r["nextSequence"], 1);
        assert_eq!(r["meetingId"], meeting);
        assert!(store::export_library().is_err());
        let incomplete = json!({"chunkCount":2,"totalFrames":4,"gaps":[],"interrupted":false});
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            incomplete,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let saved_file = pcm_dir(&id).join(format!("0-{}.pcm", hash(&data)));
        fs::write(&saved_file, [9; 8]).unwrap();
        let manifest = json!({"chunkCount":1,"totalFrames":4,"gaps":[{"atFrame":2,"pauseMs":100}],"interrupted":false});
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            manifest.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::GONE);
        fs::write(&saved_file, &data).unwrap();
        let (status, r) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            manifest.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(r["status"], "complete");
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            manifest.clone(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let mut bad_manifest = manifest.clone();
        bad_manifest["interrupted"] = json!(true);
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            bad_manifest,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _, bytes) = send(
            &app,
            "GET",
            &format!("/api/extensions/meetings/{meeting}/audio"),
            "http://localhost:3000",
            None,
            vec![],
            &[],
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(&bytes[..44], &wav_header(4));
        assert_eq!(&bytes[44..], &data);
        let (status, headers, bytes) = send(
            &app,
            "GET",
            &format!("/api/extensions/meetings/{meeting}/audio"),
            "http://localhost:3000",
            None,
            vec![],
            &[("range", "bytes=42-47".into())],
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(headers[header::CONTENT_RANGE], "bytes 42-47/52");
        assert_eq!(&bytes[2..], &data[..4]);
        let (status, _) = json_request(
            &app,
            "POST",
            &format!("{status_path}/lease"),
            "http://localhost:3000",
            None,
            json!({"ownerId":"tab2"}),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(store::with_db(|db| Ok(recording(db, &id)?["draft"].is_object())).unwrap());
        store::update_meeting(&meeting, json!({"status":"processing"})).unwrap();
        assert!(store::with_db(|db| Ok(recording(db, &id)?["draft"].is_object())).unwrap());
        store::add_transcript(
            &meeting,
            json!({"model":"large-v3","passages":[],"vocabulary":[]}),
        )
        .unwrap();
        assert!(store::with_db(|db| Ok(recording(db, &id)?["draft"].is_null())).unwrap());
        let backup = store::export_library().unwrap();
        assert_eq!(backup["extensionRecordings"][0]["recordingId"], id);
        assert!(validate_receipts(&json!([]), backup["meetings"].as_array().unwrap()).is_err());
        let completed = store::get_meeting(&meeting).unwrap().unwrap();
        let (_, parts) =
            store::get_audio_parts(&meeting, completed["tracks"][0]["id"].as_str().unwrap())
                .unwrap();
        let saved_wav = fs::read(&parts[0].path).unwrap();
        fs::remove_file(&parts[0].path).unwrap();
        let (status, _) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
        assert_eq!(status, StatusCode::GONE);
        store::write_private(&parts[0].path, &saved_wav).unwrap();
        assert!(!backup.to_string().contains(&token));
        assert!(!backup.to_string().contains(&code));
        store::delete_meeting(&meeting).unwrap();
        assert!(!pcm_dir(&id).exists());
        let (_, r) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
        assert_eq!(r["status"], "deleted");
        let (_, r) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
        assert_eq!(r["status"], "deleted");
        let (_, r) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            manifest,
        )
        .await;
        assert_eq!(r["status"], "deleted");
        assert!(store::import_library(backup).is_err());
        let tombstone_backup = store::export_library().unwrap();
        assert_eq!(
            tombstone_backup["extensionRecordings"][0]["status"],
            "deleted"
        );
        let (status, _) = json_request(
            &app,
            "DELETE",
            &format!("/api/extensions/connections/{install}"),
            "http://localhost:3000",
            None,
            json!({}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let (status, _) = json_request(&app, "GET", &path, ORIGIN, Some(&token), json!({})).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = json_request(
            &app,
            "POST",
            "/extension/v1/pairing/claim",
            ORIGIN,
            None,
            claim,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let expired_install = Uuid::new_v4().to_string();
        let (_, expired_code, expired_request) = pair(&app, &expired_install).await;
        store::with_db(|db| {
            db.execute(
                "UPDATE extension_pairing SET expires=? WHERE request_id=?",
                params![seconds() - 1, expired_request],
            )?;
            Ok(())
        })
        .unwrap();
        let (status, _) = json_request(&app, "POST", "/extension/v1/pairing/claim", ORIGIN, None, json!({"code":expired_code,"requestId":expired_request,"installationId":expired_install})).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _, bytes) = send(
            &app,
            "PUT",
            &chunk_path,
            ORIGIN,
            Some(&token),
            vec![0; 256 * 1024 + 1],
            &extra,
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["protocolVersion"],
            1
        );
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    #[tokio::test]
    async fn thirty_minute_parts_form_one_stream_and_portable_receipts_restore() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::init().unwrap();
        let app = app();
        let install = Uuid::new_v4().to_string();
        let (token, _, _) = pair(&app, &install).await;
        let id = Uuid::new_v4().to_string();
        let path = format!("/extension/v1/recordings/{id}");
        let (status, r) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
        assert_eq!(status, StatusCode::OK);
        let meeting = r["meetingId"].as_str().unwrap().to_string();
        let block = vec![17u8; (RATE * 2) as usize];
        let tail = vec![29u8; 2];
        store::mkdir(&pcm_dir(&id)).unwrap();
        store::write_private(&pcm_dir(&id).join("fixture-block.pcm"), &block).unwrap();
        store::write_private(&pcm_dir(&id).join("fixture-tail.pcm"), &tail).unwrap();
        store::with_db(|db| {
            let tx = db.transaction()?;
            for sequence in 0..1800 {
                tx.execute(
                    "INSERT INTO extension_chunks VALUES(?,?,?,?,?)",
                    params![id, sequence, RATE, hash(&block), "fixture-block.pcm"],
                )?;
            }
            tx.execute(
                "INSERT INTO extension_chunks VALUES(?,?,?,?,?)",
                params![id, 1800, 1, hash(&tail), "fixture-tail.pcm"],
            )?;
            let mut r = recording(&tx, &id)?;
            r["nextSequence"] = json!(1801);
            r["totalFrames"] = json!(PART_FRAMES + 1);
            save_recording(&tx, &r)?;
            let mut m = store::require_meeting(&tx, &meeting)?;
            m["extensionRecording"]["totalFrames"] = json!(PART_FRAMES + 1);
            store::save(&tx, &mut m)?;
            tx.commit()?;
            Ok(())
        })
        .unwrap();
        let (status, r) = json_request(
            &app,
            "POST",
            &format!("{path}/complete"),
            ORIGIN,
            Some(&token),
            json!({"chunkCount":1801,"totalFrames":PART_FRAMES+1,"gaps":[],"interrupted":false}),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(r["status"], "complete");
        let m = store::get_meeting(&meeting).unwrap().unwrap();
        assert_eq!(m["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(m["tracks"][0]["bytes"], 44 + PART_FRAMES * 2);
        assert_eq!(m["tracks"][1]["bytes"], 46);
        assert_eq!(m["duration"], (PART_FRAMES + 1) as f64 / RATE as f64);
        let boundary = 44 + PART_FRAMES * 2;
        let (status, _, bytes) = send(
            &app,
            "GET",
            &format!("/api/extensions/meetings/{meeting}/audio"),
            "http://localhost:3000",
            None,
            vec![],
            &[("range", format!("bytes={}-{}", boundary - 2, boundary + 1))],
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(bytes, vec![17, 17, 29, 29]);
        let backup = store::export_library().unwrap();
        assert_eq!(backup["extensionRecordings"][0]["recordingId"], id);
        let restored_directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", restored_directory.path());
        store::import_library(backup.clone()).unwrap();
        let restored = store::get_meeting(&meeting).unwrap().unwrap();
        assert_eq!(restored["extensionRecording"], m["extensionRecording"]);
        assert_eq!(
            store::with_db(|db| Ok(recording(db, &id)?["status"].clone())).unwrap(),
            "complete"
        );
        assert_eq!(
            store::with_db(|db| Ok(db.query_row(
                "SELECT COUNT(*) FROM extension_connections",
                [],
                |r| r.get::<_, i64>(0)
            )?))
            .unwrap(),
            0
        );
        let (status, _, bytes) = send(
            &app,
            "GET",
            &format!("/api/extensions/meetings/{meeting}/audio"),
            "http://localhost:3000",
            None,
            vec![],
            &[("range", format!("bytes={}-{}", boundary - 2, boundary + 1))],
        )
        .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT);
        assert_eq!(bytes, vec![17, 17, 29, 29]);
        let mut corrupted = backup;
        corrupted["extensionRecordings"][0]["totalFrames"] = json!(1);
        assert!(validate_receipts(
            &corrupted["extensionRecordings"],
            corrupted["meetings"].as_array().unwrap()
        )
        .is_err());
        store::delete_meeting(&meeting).unwrap();
        let tombstones = store::export_library().unwrap();
        let tombstone_directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", tombstone_directory.path());
        store::import_library(tombstones).unwrap();
        assert_eq!(
            store::with_db(|db| Ok(recording(db, &id)?["status"].clone())).unwrap(),
            "deleted"
        );
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    #[tokio::test]
    async fn start_accepts_current_and_legacy_meeting_hosts_but_rejects_lookalikes() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::init().unwrap();
        let app = app();
        let (token, _, _) = pair(&app, &Uuid::new_v4().to_string()).await;
        for (provider, host, path) in [
            ("meet", "meet.google.com", "/aaa-bbbb-ccc"),
            ("zoom", "zoom.us", "/wc/123456/join"),
            ("zoom", "us02web.zoom.us", "/wc/123456/join"),
            ("zoom", "app.zoom.com", "/wc/123456/join"),
            ("teams", "teams.microsoft.com", "/l/meetup-join/test"),
            ("teams", "teams.live.com", "/meet/test"),
            ("teams", "teams.cloud.microsoft", "/l/meetup-join/test"),
        ] {
            let mut metadata = input();
            metadata["provider"] = json!(provider);
            metadata["meetingUrl"] = json!(format!("https://{host}{path}"));
            let (status, recording) = json_request(
                &app,
                "PUT",
                &format!("/extension/v1/recordings/{}", Uuid::new_v4()),
                ORIGIN,
                Some(&token),
                metadata,
            )
            .await;
            assert_eq!(status, StatusCode::OK, "{provider} {host}");
            assert_eq!(recording["status"], "receiving");
        }
        for (provider, host) in [
            ("meet", "meet.google.com.evil.example"),
            ("zoom", "app.zoom.com.evil.example"),
            ("zoom", "evilapp.zoom.com"),
            ("zoom", "evil.zoom.com"),
            ("zoom", "zoom.us.evil.example"),
            ("zoom", "evilzoom.us"),
            ("teams", "teams.cloud.microsoft.evil.example"),
            ("teams", "evilteams.cloud.microsoft"),
            ("teams", "teams.microsoft.com.evil.example"),
            ("teams", "teams.live.com.evil.example"),
            ("teams", "app.zoom.com"),
        ] {
            let mut metadata = input();
            metadata["provider"] = json!(provider);
            metadata["meetingUrl"] = json!(format!("https://{host}/meeting/test"));
            let (status, _) = json_request(
                &app,
                "PUT",
                &format!("/extension/v1/recordings/{}", Uuid::new_v4()),
                ORIGIN,
                Some(&token),
                metadata,
            )
            .await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{provider} {host}");
        }
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    #[tokio::test]
    async fn orphan_retries_resync_files_and_directories_before_durable_ack() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let directory = tempfile::tempdir().unwrap();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::init().unwrap();
        let app = app();
        let (token, _, _) = pair(&app, &Uuid::new_v4().to_string()).await;
        let pcm = vec![1, 0, 2, 0, 3, 0, 4, 0];
        let extra = [("x-echo-frames", "4".into()), ("x-echo-sha256", hash(&pcm))];
        for fail_directory in [false, true] {
            let id = Uuid::new_v4().to_string();
            let path = format!("/extension/v1/recordings/{id}");
            let (status, _) = json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
            assert_eq!(status, StatusCode::OK);
            let dir = pcm_dir(&id);
            store::mkdir(&dir).unwrap();
            let file = dir.join(format!("0-{}.pcm", hash(&pcm)));
            // Valid content without fsync models a process death/failed prior durability attempt.
            fs::write(&file, &pcm).unwrap();
            let target = if fail_directory {
                dir.clone()
            } else {
                file.clone()
            };
            *SYNC_FAULT.lock().unwrap() = Some(SyncFault {
                path: target,
                failures_remaining: 1,
                calls: 0,
            });
            let (status, _, _) = send(
                &app,
                "PUT",
                &format!("{path}/chunks/0"),
                ORIGIN,
                Some(&token),
                pcm.clone(),
                &extra,
            )
            .await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(fs::read(&file).unwrap(), pcm);
            store::with_db(|db| {
                assert_eq!(recording(db, &id)?["nextSequence"], 0);
                assert_eq!(
                    db.query_row(
                        "SELECT COUNT(*) FROM extension_chunks WHERE recording_id=?",
                        [&id],
                        |row| row.get::<_, i64>(0)
                    )?,
                    0
                );
                Ok(())
            })
            .unwrap();
            let (status, _, _) = send(
                &app,
                "PUT",
                &format!("{path}/chunks/0"),
                ORIGIN,
                Some(&token),
                pcm.clone(),
                &extra,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let fault = SYNC_FAULT.lock().unwrap().take().unwrap();
            assert_eq!(
                fault.calls, 2,
                "retry must repeat the failed durability step"
            );
            store::with_db(|db| {
                assert_eq!(recording(db, &id)?["nextSequence"], 1);
                Ok(())
            })
            .unwrap();
        }
        for fail_directory in [false, true] {
            let id = Uuid::new_v4().to_string();
            let path = format!("/extension/v1/recordings/{id}");
            let (status, started) =
                json_request(&app, "PUT", &path, ORIGIN, Some(&token), input()).await;
            assert_eq!(status, StatusCode::OK);
            let meeting = started["meetingId"].as_str().unwrap();
            let (status, _, _) = send(
                &app,
                "PUT",
                &format!("{path}/chunks/0"),
                ORIGIN,
                Some(&token),
                pcm.clone(),
                &extra,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let dir = store::data_dir().join("audio").join(meeting);
            store::mkdir(&dir).unwrap();
            let mut wav = wav_header(4);
            wav.extend_from_slice(&pcm);
            let file = dir.join(format!("extension-0-{}.wav", hash(&wav)));
            fs::write(&file, &wav).unwrap();
            let target = if fail_directory {
                dir.clone()
            } else {
                file.clone()
            };
            *SYNC_FAULT.lock().unwrap() = Some(SyncFault {
                path: target,
                failures_remaining: 1,
                calls: 0,
            });
            let manifest = json!({"chunkCount":1,"totalFrames":4,"gaps":[],"interrupted":false});
            let (status, _) = json_request(
                &app,
                "POST",
                &format!("{path}/complete"),
                ORIGIN,
                Some(&token),
                manifest.clone(),
            )
            .await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(fs::read(&file).unwrap(), wav);
            store::with_db(|db| {
                assert_eq!(recording(db, &id)?["status"], "receiving");
                assert_eq!(
                    db.query_row(
                        "SELECT COUNT(*) FROM audio_chunks WHERE meeting_id=?",
                        [meeting],
                        |row| row.get::<_, i64>(0)
                    )?,
                    0
                );
                assert!(store::require_meeting(db, meeting)?["tracks"]
                    .as_array()
                    .unwrap()
                    .is_empty());
                Ok(())
            })
            .unwrap();
            let (status, completed) = json_request(
                &app,
                "POST",
                &format!("{path}/complete"),
                ORIGIN,
                Some(&token),
                manifest,
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(completed["status"], "complete");
            let fault = SYNC_FAULT.lock().unwrap().take().unwrap();
            assert_eq!(
                fault.calls, 2,
                "reused WAV must repeat the failed durability step"
            );
            store::with_db(|db| {
                assert_eq!(
                    db.query_row(
                        "SELECT COUNT(*) FROM audio_chunks WHERE meeting_id=?",
                        [meeting],
                        |row| row.get::<_, i64>(0)
                    )?,
                    1
                );
                Ok(())
            })
            .unwrap();
        }
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    #[test]
    fn committed_temporal_ownership_allows_new_overlapping_words() {
        let old_word = json!({"text":"committed","startFrame":8,"endFrame":9,"provisional":false});
        let old = json!({"throughFrame":12,"committedThroughFrame":10,"words":[old_word]});
        let incoming =
            json!({"text":"new overlap","startFrame":7,"endFrame":14,"provisional":false});
        let submitted = vec![incoming.clone(), old_word.clone()];
        assert!(committed_words_match(&old, &submitted));
        let mut changed = old_word.clone();
        changed["text"] = json!("rewritten");
        assert!(!committed_words_match(&old, &[incoming.clone(), changed]));
        assert!(!committed_words_match(
            &old,
            std::slice::from_ref(&incoming)
        ));
        let invented_old = json!({"text":"invented prior-owned word","startFrame":5,"endFrame":6,"provisional":false});
        assert!(!committed_words_match(
            &old,
            &[invented_old, incoming, old_word]
        ));
    }
    #[test]
    fn validated_loopback_hosts_and_ranges() {
        for host in [
            "localhost:3000",
            "127.0.0.1:3000",
            "[::1]:3000",
            "localhost",
        ] {
            assert!(
                loopback(&HeaderMap::from_iter([(
                    header::HOST,
                    HeaderValue::from_str(host).unwrap()
                )])),
                "{host}"
            );
        }
        assert_eq!(audio_range(Some("bytes=-8"), 52).unwrap(), (44, 51, true));
        assert_eq!(audio_range(Some("bytes=44-"), 52).unwrap(), (44, 51, true));
        assert!(audio_range(Some("bytes=52-"), 52).is_err());
        assert!(audio_range(Some("bytes=0-1,4-5"), 52).is_err());
    }
}
