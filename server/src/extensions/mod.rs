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
mod pairing;
pub(crate) use pairing::cleanup_loop as cleanup_pairing_loop;
mod vault;
use pairing::{approve, cancel, claim, hello, intent, pair, reject, request_metadata};
type Result<T> = std::result::Result<T, ApiError>;
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
    db.execute("DELETE FROM extension_pairing", [])?;
    vault::init_schema(db)?;
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
fn public_recording(mut r: Value, lib: &str) -> Result<Value> {
    let object = r
        .as_object_mut()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
    for key in ["lease", "manifest", "input", "controlHistory"] {
        object.remove(key);
    }
    object.insert("libraryId".into(), json!(lib));
    Ok(r)
}
fn extension_recording(r: Value, lib: &str) -> Result<Value> {
    let mut value = public_recording(r, lib)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?;
    object.remove("draft");
    object.remove("liveStatus");
    Ok(value)
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
        r.as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("draft");
        r.as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("lease");
        for key in [
            "input",
            "title",
            "provider",
            "createdAt",
            "manifest",
            "controlHistory",
        ] {
            r.as_object_mut()
                .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
                .remove(key);
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
        r.as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("lease");
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
        r.as_object_mut()
            .ok_or_else(|| ApiError::bad("Invalid or corrupted saved data."))?
            .remove("draft");
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
        Response::from_parts(parts, axum::body::Body::from(v.to_string()))
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
    let Ok(origin) = origin else {
        return reply_error(ApiError::new(
            403,
            "Extension access requires a validated origin.",
        ));
    };
    let Ok(origin_header) = HeaderValue::from_str(&origin) else {
        return reply_error(ApiError::new(
            403,
            "Extension access requires a validated origin.",
        ));
    };
    let mut response = if req.method() == Method::OPTIONS {
        (StatusCode::NO_CONTENT, "").into_response()
    } else {
        protocol_response(next.run(req).await).await
    };
    response
        .headers_mut()
        .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin_header);
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
        .route("/vault", get(vault::read).delete(vault::remove))
        .route("/hello", get(hello))
        .route("/pair", post(pair))
        .route("/pair/claim", post(claim))
        .route("/pair/{id}", delete(cancel))
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
        .route("/extensions/intent", post(intent))
        .route("/extensions/connections", get(connections))
        .route("/extensions/requests/{id}", get(request_metadata))
        .route("/extensions/requests/{id}/approve", post(approve))
        .route("/extensions/requests/{id}/reject", post(reject))
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
    store::run(move |db| {
        let installation = authenticated(db, &headers)?;
        Ok(reply(
            json!({"installationId":installation,"libraryId":library(db)?,"appVersion":env!("CARGO_PKG_VERSION"),"storageProtectionVersion":1,"recordingReceiptVersion":1}),
        ))
    }).await
}
async fn disconnect(headers: HeaderMap) -> Result<Json<Value>> {
    store::run(move |db| {
        let installation = authenticated(db, &headers)?;
        pairing::revoke_connection(db, &installation)?;
        Ok(reply(json!({"status":"disconnected"})))
    })
    .await
}
/// List paired browsers, undecided requests for the approval sheet, and the unpacked extension folder.
async fn connections() -> Result<Json<Value>> {
    let extension_path = crate::paths::get()?.resource_root.join("extension/dist");
    store::run(move |db| {
        let mut stmt = db.prepare("SELECT installation_id,name,origin,created_at FROM extension_connections ORDER BY created_at")?;
        let connections = stmt.query_map([], |r| Ok(json!({"installationId":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"origin":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        let mut stmt = db.prepare("SELECT request_id,installation_id,name,origin,expires FROM extension_pairing WHERE state='pending' AND expires>? ORDER BY expires")?;
        let pending = stmt.query_map([seconds()], |r| Ok(json!({"requestId":r.get::<_,String>(0)?,"installationId":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"origin":r.get::<_,String>(3)?,"expiresAt":r.get::<_,i64>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(reply(json!({"libraryId":library(db)?,"connections":connections,"pending":pending,"extensionPath":extension_path.to_string_lossy()})))
    }).await
}
async fn revoke(Path(id): Path<String>) -> Result<Json<Value>> {
    uid(&id)?;
    store::run(move |db| {
        pairing::revoke_connection(db, &id)?;
        Ok(reply(json!({"status":"revoked"})))
    })
    .await
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
        let dir = pcm_dir(&id)?;
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

mod live;
mod recordings;
mod workspace;
use live::*;
use recordings::*;
use workspace::*;
#[cfg(test)]
mod tests;
