use crate::{security::ApiError, store};
use axum::{
    body::Body,
    extract::{rejection::JsonRejection, DefaultBodyLimit, Multipart, Path, Query},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
type ApiResult<T> = Result<T, ApiError>;
type Payload = Result<Json<Value>, JsonRejection>;
/// Convert extractor failures into actionable JSON errors shared by API clients.
fn payload(value: Payload) -> ApiResult<Value> {
    value.map(|v| v.0).map_err(|e| {
        ApiError::new(
            e.status().as_u16(),
            format!("Invalid request: {}", e.body_text()),
        )
    })
}

/// Register meeting, vocabulary, settings, backup, and audio endpoints with size limits.
pub fn routes() -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/meetings", get(list).post(create))
        .route("/meetings/{id}", get(read).patch(update).delete(delete))
        .route("/processing/heartbeat", post(processing_heartbeat))
        .route(
            "/meetings/{id}/audio",
            post(upload).layer(DefaultBodyLimit::max(130 * 1024 * 1024)),
        )
        .route("/meetings/{id}/audio/{track}", get(audio))
        .route("/meetings/{id}/transcripts", post(transcript))
        .route("/meetings/{id}/notes", post(notes))
        .route("/meetings/{id}/moments", post(moment))
        .route(
            "/meetings/{id}/moments/{moment}",
            patch(edit_moment).delete(remove_moment),
        )
        .route("/meetings/{id}/export", get(export))
        .route("/settings", get(settings).patch(edit_settings))
        .route("/vocabulary", get(vocabulary).post(new_vocabulary))
        .route(
            "/vocabulary/{id}",
            patch(edit_vocabulary).delete(remove_vocabulary),
        )
        .route("/storage", get(storage))
        .route("/storage/export", get(backup))
        .route(
            "/storage/import",
            post(restore).layer(DefaultBodyLimit::max(256 * 1024 * 1024)),
        )
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
}
/// Report local storage readiness without exposing private paths or credentials.
async fn health() -> ApiResult<Json<Value>> {
    store::init()?;
    Ok(Json(
        json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"storage":"local","framework":"Dioxus + Axum"}),
    ))
}
/// Return the saved meeting library.
async fn list() -> ApiResult<Json<Value>> {
    Ok(Json(json!({"meetings":store::list_meetings()?})))
}
/// Validate creation input and return the new meeting with HTTP 201.
async fn create(value: Payload) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        Json(store::create_meeting(payload(value)?)?),
    ))
}
/// Return a meeting or the deleted-meeting error.
async fn read(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(
        store::get_meeting(&id)?.ok_or_else(ApiError::not_found)?,
    ))
}
/// Apply an allowlisted meeting patch through the store.
async fn update(Path(id): Path<String>, value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::update_meeting(&id, payload(value)?)?))
}
/// Restore only restarted status markers claimed by still-running browser jobs.
async fn processing_heartbeat(value: Payload) -> ApiResult<Json<Value>> {
    let body = payload(value)?;
    let ids = body["meetingIds"]
        .as_array()
        .filter(|ids| !ids.is_empty() && ids.len() <= 100)
        .ok_or_else(|| ApiError::bad("Supply between one and 100 active browser meeting IDs."))?;
    let ids: Vec<String> = ids
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .ok_or_else(|| ApiError::bad("Active meeting IDs must be strings."))
        })
        .collect::<ApiResult<_>>()?;
    Ok(Json(
        json!({"restored": store::resume_browser_processing(&ids)?}),
    ))
}
/// Remove an inactive meeting and return a deletion acknowledgement.
async fn delete(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    store::delete_meeting(&id)?;
    Ok(Json(json!({"ok":true})))
}
/// Append a transcript version to the requested meeting.
async fn transcript(Path(id): Path<String>, value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::add_transcript(&id, payload(value)?)?))
}
/// Append supplied evidence-linked notes to the requested meeting.
async fn notes(Path(id): Path<String>, value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::add_notes(&id, payload(value)?)?))
}
/// Create a timestamped bookmark within a meeting.
async fn moment(Path(id): Path<String>, value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::add_moment(&id, payload(value)?)?))
}
/// Apply a validated patch to one bookmark.
async fn edit_moment(
    Path((id, moment)): Path<(String, String)>,
    value: Payload,
) -> ApiResult<Json<Value>> {
    Ok(Json(store::update_moment(&id, &moment, payload(value)?)?))
}
/// Delete one bookmark without changing other saved history.
async fn remove_moment(Path((id, moment)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    Ok(Json(store::delete_moment(&id, &moment)?))
}
/// Return normalized workspace preferences.
async fn settings() -> ApiResult<Json<Value>> {
    Ok(Json(store::get_settings()?))
}
/// Persist a validated workspace preference patch.
async fn edit_settings(value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::update_settings(payload(value)?)?))
}
/// Return the shared transcription vocabulary.
async fn vocabulary() -> ApiResult<Json<Value>> {
    Ok(Json(json!({"entries":store::list_vocabulary()?})))
}
/// Create a vocabulary entry with HTTP 201.
async fn new_vocabulary(value: Payload) -> ApiResult<(StatusCode, Json<Value>)> {
    Ok((
        StatusCode::CREATED,
        Json(store::add_vocabulary(payload(value)?)?),
    ))
}
/// Update a term and its aliases through the store.
async fn edit_vocabulary(Path(id): Path<String>, value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::update_vocabulary(&id, payload(value)?)?))
}
/// Delete a vocabulary entry and acknowledge completion.
async fn remove_vocabulary(Path(id): Path<String>) -> ApiResult<Json<Value>> {
    store::delete_vocabulary(&id)?;
    Ok(Json(json!({"ok":true})))
}
/// Return library counts and managed disk usage.
async fn storage() -> ApiResult<Json<Value>> {
    Ok(Json(store::storage_info()?))
}
/// Download a portable library backup that excludes integration credentials.
async fn backup() -> ApiResult<Response> {
    let backup = store::export_library()?;
    download(
        serde_json::to_string(&backup)?,
        "application/json",
        "echo-voice-library.json",
    )
}
/// Validate and import a portable library backup.
async fn restore(value: Payload) -> ApiResult<Json<Value>> {
    Ok(Json(store::import_library(payload(value)?)?))
}
/// Download a meeting in the requested supported document format.
async fn export(
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (body, mime, filename) =
        store::export_meeting(&id, query.get("format").map(String::as_str).unwrap_or("md"))?;
    download(body, mime, &filename)
}
/// Build a typed attachment response with a safely quoted filename.
fn download(body: String, mime: &str, filename: &str) -> ApiResult<Response> {
    Response::builder()
        .header(header::CONTENT_TYPE, format!("{mime}; charset=utf-8"))
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .map_err(|_| {
            ApiError::new(
                500,
                "The export could not be created. The saved meeting is unchanged.",
            )
        })
}
/// Validate multipart audio and persist a bounded chunk with retry identity.
async fn upload(
    Path(id): Path<String>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let mut data = None;
    let mut track = None;
    let mut label = None;
    let mut mime = None;
    let mut sequence = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::bad("This audio upload is incomplete. Retry the original chunk."))?
    {
        let name = field.name().unwrap_or("").to_string();
        if name == "file" || name == "audio" {
            if data.is_some() {
                return Err(ApiError::bad("Upload one audio file at a time."));
            }
            if mime.is_none() {
                mime = field.content_type().map(str::to_string);
            }
            let bytes = field.bytes().await.map_err(|_| {
                ApiError::new(
                    413,
                    "This audio upload is incomplete or exceeds the 128 MB limit.",
                )
            })?;
            if bytes.len() > 128 * 1024 * 1024 {
                return Err(ApiError::new(
                    413,
                    "Each audio upload must be smaller than 128 MB.",
                ));
            }
            data = Some(bytes);
        } else {
            let text = field
                .text()
                .await
                .map_err(|_| ApiError::bad("An audio upload field is invalid."))?;
            if text.len() > 1000 {
                return Err(ApiError::bad("An audio upload field is too long."));
            }
            match name.as_str() {
                "trackId" => track = Some(text),
                "label" => label = Some(text),
                "mimeType" => mime = Some(text),
                "sequence" | "chunkIndex" => {
                    sequence = Some(
                        text.parse::<i64>()
                            .map_err(|_| ApiError::bad("The audio sequence must be an integer."))?,
                    )
                }
                _ => {
                    return Err(ApiError::bad(
                        "The audio upload contains an unsupported field.",
                    ))
                }
            }
        }
    }
    let data = data.ok_or_else(|| ApiError::bad("Choose an audio file to upload."))?;
    let result = store::add_audio(
        &id,
        &data,
        track.as_deref(),
        label.as_deref().unwrap_or("Room microphone"),
        mime.as_deref().unwrap_or("audio/webm"),
        sequence,
    )?;
    Ok((StatusCode::CREATED, Json(result)))
}
/// Parse a single HTTP byte range, including suffix and open-ended requests.
fn range(value: Option<&str>, size: u64) -> ApiResult<(u64, u64, bool)> {
    if size == 0 {
        return Err(ApiError::new(416, "The recording is empty."));
    }
    let Some(value) = value else {
        return Ok((0, size - 1, false));
    };
    let parts = value
        .strip_prefix("bytes=")
        .and_then(|r| r.split_once('-'))
        .filter(|(a, b)| !a.contains(',') && !b.contains(','))
        .ok_or_else(|| ApiError::new(416, "Choose one valid audio playback range."))?;
    let (start, end) = if parts.0.is_empty() {
        let suffix = parts
            .1
            .parse::<u64>()
            .map_err(|_| ApiError::new(416, "Invalid audio playback range."))?;
        if suffix == 0 {
            return Err(ApiError::new(416, "Invalid audio playback range."));
        }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start = parts
            .0
            .parse::<u64>()
            .map_err(|_| ApiError::new(416, "Invalid audio playback range."))?;
        let end = if parts.1.is_empty() {
            size - 1
        } else {
            parts
                .1
                .parse::<u64>()
                .map_err(|_| ApiError::new(416, "Invalid audio playback range."))?
                .min(size - 1)
        };
        (start, end)
    };
    if start >= size || end < start {
        return Err(ApiError::new(
            416,
            "The requested audio time is outside this recording.",
        ));
    }
    Ok((start, end, true))
}
/// Stream ordered audio chunks with range support and private cache headers.
async fn audio(
    Path((id, track_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (track, parts) = store::get_audio_parts(&id, &track_id)?;
    let total = track["bytes"].as_u64().unwrap_or(0);
    let (start, end, partial) = match range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        total,
    ) {
        Ok(r) => r,
        Err(e) => {
            let mut response = e.into_response();
            response.headers_mut().insert(
                header::CONTENT_RANGE,
                format!("bytes */{total}").parse().unwrap(),
            );
            return Ok(response);
        }
    };
    let stream = async_stream::stream! {
        let mut offset=0u64;
        for part in parts {
            let chunk_start=offset;let chunk_end=offset+part.bytes;offset=chunk_end;
            if chunk_end<=start||chunk_start>end{continue;}
            let local_start=start.saturating_sub(chunk_start);let local_end=(end+1).min(chunk_end)-chunk_start;let mut remaining=local_end-local_start;
            let mut file=match tokio::fs::File::open(&part.path).await{Ok(file)=>file,Err(error)=>{yield Err::<Vec<u8>,std::io::Error>(error);break;}};
            if let Err(error)=file.seek(std::io::SeekFrom::Start(local_start)).await{yield Err(error);break;}
            while remaining>0{let mut buffer=vec![0u8;remaining.min(64*1024)as usize];match file.read(&mut buffer).await{Ok(0)=>{yield Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof,"A saved audio chunk is incomplete."));return;},Ok(count)=>{buffer.truncate(count);remaining-=count as u64;yield Ok(buffer);},Err(error)=>{yield Err(error);return;}}}
        }
    };
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(
            header::CONTENT_TYPE,
            track["mimeType"].as_str().unwrap_or("audio/webm"),
        )
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, (end - start + 1).to_string())
        .header(header::CACHE_CONTROL, "no-store");
    if partial {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }
    if query.get("download").map(String::as_str) == Some("1") {
        let label = track["label"]
            .as_str()
            .unwrap_or("audio")
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
            .take(80)
            .collect::<String>();
        let ext = match track["mimeType"].as_str() {
            Some("audio/wav" | "audio/x-wav") => "wav",
            Some("audio/mpeg" | "audio/mp3") => "mp3",
            Some("audio/ogg") => "ogg",
            Some("audio/mp4" | "audio/x-m4a" | "video/mp4") => "m4a",
            Some("audio/flac") => "flac",
            _ => "webm",
        };
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{label}.{ext}\""),
        );
    }
    response
        .body(Body::from_stream(stream))
        .map_err(|_| ApiError::new(500, "The saved audio could not be opened."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playback_ranges_cover_suffix_open_and_invalid() {
        assert_eq!(range(None, 100).unwrap(), (0, 99, false));
        assert_eq!(range(Some("bytes=10-20"), 100).unwrap(), (10, 20, true));
        assert_eq!(range(Some("bytes=95-"), 100).unwrap(), (95, 99, true));
        assert_eq!(range(Some("bytes=-5"), 100).unwrap(), (95, 99, true));
        assert!(range(Some("bytes=100-"), 100).is_err());
        assert!(range(Some("bytes=20-10"), 100).is_err());
        assert!(range(Some("bytes=0-1,3-4"), 100).is_err());
        assert!(range(None, 0).is_err());
    }
}

#[cfg(test)]
mod request_tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    #[tokio::test]
    async fn malformed_requests_have_actionable_json_errors() {
        for body in [
            "not json",
            "[]",
            "null",
            "{\"title\":\"   \"}",
            "{\"title\":\"Meeting\",\"mode\":\"in-person\",\"consent\":false}",
        ] {
            let request = Request::builder()
                .method("POST")
                .uri("/meetings")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .unwrap();
            let response = routes().oneshot(request).await.unwrap();
            assert!(response.status().is_client_error());
            let data = response.into_body().collect().await.unwrap().to_bytes();
            let value: Value = serde_json::from_slice(&data).unwrap();
            assert!(value["error"].as_str().unwrap().len() > 10);
        }
        for path in ["/vocabulary", "/meetings/meeting-1/transcripts"] {
            let request = Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .body(Body::from("[]"))
                .unwrap();
            let response = routes().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }
}
