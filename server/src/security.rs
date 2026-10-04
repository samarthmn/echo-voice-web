use axum::{
    extract::Request,
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub message: String,
}
impl ApiError {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.into(),
        }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
    pub fn not_found() -> Self {
        Self::new(404, "This meeting was deleted or could not be found.")
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error":self.message}))).into_response()
    }
}
impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        eprintln!("[Echo Voice storage] {e}");
        match e.kind() { std::io::ErrorKind::PermissionDenied=>Self::new(500,"Cannot write to the local data folder. Check its permissions and restart Echo Voice."), _ if e.raw_os_error()==Some(28)=>Self::new(507,"Your local disk is full. Free some space and retry; saved recordings remain available."), _=>Self::new(500,"A local file could not be accessed. Check the server terminal and restore missing audio from a backup if needed.") }
    }
}
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        eprintln!("[Echo Voice database] {e}");
        if let rusqlite::Error::SqliteFailure(code, _) = &e {
            if code.code == rusqlite::ErrorCode::DiskFull {
                return Self::new(507, "Your local disk is full. Free some space and retry; saved recordings remain available.");
            }
            if matches!(
                code.code,
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
            ) {
                return Self::new(
                    503,
                    "The local workspace is busy saving another change. Wait a moment and retry.",
                );
            }
        }
        Self::new(500,"The local database could not complete this request. Retry and check the server terminal if it continues.")
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(_: serde_json::Error) -> Self {
        Self::bad("The request or saved data contains invalid JSON.")
    }
}

/// Protects reads from DNS rebinding and changes from hostile browser origins.
/// ECHO_ALLOWED_ORIGIN is an explicit reverse-proxy opt-in; forwarded headers are never trusted.
pub async fn local_access(request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    let fetch_site = request
        .headers()
        .get("sec-fetch-site")
        .and_then(|v| v.to_str().ok());
    let configured = std::env::var("ECHO_ALLOWED_ORIGIN").ok();
    let local_host = host == "localhost"
        || host.starts_with("localhost:")
        || host == "127.0.0.1"
        || host.starts_with("127.0.0.1:")
        || host == "[::1]"
        || host.starts_with("[::1]:");
    let proxy_host = configured
        .as_deref()
        .and_then(|s| s.split_once("://").map(|(_, s)| s))
        .map(|s| s == host)
        .unwrap_or(false);
    let same_origin = origin
        .map(|o| {
            o == format!("http://{host}")
                || o == format!("https://{host}")
                || configured.as_deref() == Some(o)
        })
        .unwrap_or(true);
    // Both public OAuth endpoints can be top-level cross-site navigations.
    // The connect route may normalize 127.0.0.1 to localhost for its callback cookie;
    // the callback then enforces its own short-lived PKCE/state check.
    let oauth_navigation = request.method() == axum::http::Method::GET
        && [
            "/integrations/google/connect",
            "/integrations/google/callback",
        ]
        .iter()
        .any(|path| request.uri().path().ends_with(path))
        && request
            .headers()
            .get("sec-fetch-mode")
            .and_then(|v| v.to_str().ok())
            == Some("navigate")
        && request
            .headers()
            .get("sec-fetch-dest")
            .and_then(|v| v.to_str().ok())
            == Some("document");
    if (!local_host && !proxy_host)
        || !same_origin
        || (fetch_site == Some("cross-site") && !oauth_navigation)
    {
        return ApiError::new(403,"Access from another website is blocked. Open Echo Voice directly at its local address.").into_response();
    }
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    response.headers_mut().insert(
        "x-content-type-options",
        header::HeaderValue::from_static("nosniff"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, routing::get, Router};
    use tower::ServiceExt;
    #[tokio::test]
    async fn oauth_navigation_allows_canonical_localhost_redirect_but_not_fetch() {
        let app = Router::new()
            .route(
                "/integrations/google/connect",
                get(|| async { "oauth-entry" }),
            )
            .layer(axum::middleware::from_fn(local_access));
        let navigation = Request::builder()
            .uri("/integrations/google/connect")
            .header("host", "localhost:3000")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(navigation).await.unwrap().status(),
            StatusCode::OK
        );
        let cross_fetch = Request::builder()
            .uri("/integrations/google/connect")
            .header("host", "localhost:3000")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "cors")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(cross_fetch).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn hostile_origins_and_dns_rebinding_are_rejected() {
        let app = Router::new()
            .route(
                "/data",
                get(|| async { "private" }).post(|| async { "saved" }),
            )
            .layer(axum::middleware::from_fn(local_access));
        let local = Request::builder()
            .uri("/data")
            .header("host", "127.0.0.1:3000")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(local).await.unwrap().status(),
            StatusCode::OK
        );
        let hostile = Request::builder()
            .method("POST")
            .uri("/data")
            .header("host", "127.0.0.1:3000")
            .header("origin", "https://hostile.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(hostile).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let rebinding = Request::builder()
            .uri("/data")
            .header("host", "attacker.example")
            .header("origin", "http://attacker.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(rebinding).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let opaque = Request::builder()
            .method("POST")
            .uri("/data")
            .header("host", "localhost:3000")
            .header("origin", "null")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(opaque).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let cross = Request::builder()
            .uri("/data")
            .header("host", "localhost:3000")
            .header("sec-fetch-site", "cross-site")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(cross).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
}
