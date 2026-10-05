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
    /// Construct a public API error with a valid HTTP status.
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            message: message.into(),
        }
    }
    /// Describe invalid user input as HTTP 400.
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(400, message)
    }
    /// Return the consistent deleted-meeting error without exposing storage details.
    pub fn not_found() -> Self {
        Self::new(404, "This meeting was deleted or could not be found.")
    }
}
impl std::fmt::Display for ApiError {
    /// Render the public message when an API error is displayed or logged.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    /// Return API failures as a status and JSON error object.
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"protocolVersion":1,"error":self.message})),
        )
            .into_response()
    }
}
impl From<std::io::Error> for ApiError {
    /// Translate internal failures into user-facing errors while preserving diagnostics in the server log.
    fn from(e: std::io::Error) -> Self {
        eprintln!("[Echo Voice storage] {e}");
        match e.kind() { std::io::ErrorKind::PermissionDenied=>Self::new(500,"Cannot write to the local data folder. Check its permissions and restart Echo Voice."), _ if e.raw_os_error()==Some(28)=>Self::new(507,"Your local disk is full. Free some space and retry; saved recordings remain available."), _=>Self::new(500,"A local file could not be accessed. Check the server terminal and restore missing audio from a backup if needed.") }
    }
}
impl From<rusqlite::Error> for ApiError {
    /// Translate internal failures into user-facing errors while preserving diagnostics in the server log.
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
    /// Report malformed JSON without exposing internal serialization details.
    fn from(_: serde_json::Error) -> Self {
        Self::bad("The request or saved data contains invalid JSON.")
    }
}

/// Allow isolated local documents and workers to use SharedArrayBuffer for ONNX CPU threads.
/// Remote model files are fetched using CORS; OAuth uses top-level navigation without an opener.
pub async fn browser_isolation(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "cross-origin-opener-policy",
        header::HeaderValue::from_static("same-origin"),
    );
    response.headers_mut().insert(
        "cross-origin-embedder-policy",
        header::HeaderValue::from_static("require-corp"),
    );
    response
}

/// Protects reads from DNS rebinding and changes from hostile browser origins.
/// The listener is loopback-only; these checks additionally protect browser requests.
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
    let local_host = host == "localhost"
        || host.starts_with("localhost:")
        || host == "127.0.0.1"
        || host.starts_with("127.0.0.1:")
        || host == "[::1]"
        || host.starts_with("[::1]:");
    let same_origin = origin
        .map(|o| o == format!("http://{host}") || o == format!("https://{host}"))
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
    if !local_host || !same_origin || (fetch_site == Some("cross-site") && !oauth_navigation) {
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
    async fn documents_workers_and_wasm_receive_isolation_without_changing_content_types() {
        let app = Router::new()
            .route(
                "/",
                get(|| async { ([(header::CONTENT_TYPE, "text/html")], "workspace") }),
            )
            .route(
                "/js/inference-worker.js",
                get(|| async { ([(header::CONTENT_TYPE, "text/javascript")], "worker") }),
            )
            .route(
                "/wasm/runtime.wasm",
                get(|| async { ([(header::CONTENT_TYPE, "application/wasm")], "wasm") }),
            )
            .layer(axum::middleware::from_fn(browser_isolation));
        for (path, content_type) in [
            ("/", "text/html"),
            ("/js/inference-worker.js", "text/javascript"),
            ("/wasm/runtime.wasm", "application/wasm"),
        ] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()["cross-origin-opener-policy"],
                "same-origin"
            );
            assert_eq!(
                response.headers()["cross-origin-embedder-policy"],
                "require-corp"
            );
            assert_eq!(response.headers()[header::CONTENT_TYPE], content_type);
        }
    }

    #[tokio::test]
    async fn isolated_oauth_callback_still_accepts_navigation_and_preserves_redirect_cookie() {
        let app = Router::new()
            .route(
                "/api/integrations/google/callback",
                get(|| async {
                    (
                        StatusCode::FOUND,
                        [
                            (header::LOCATION, "/"),
                            (
                                header::SET_COOKIE,
                                "oauth_state=; Max-Age=0; HttpOnly; SameSite=Lax",
                            ),
                        ],
                    )
                }),
            )
            .layer(axum::middleware::from_fn(local_access))
            .layer(axum::middleware::from_fn(browser_isolation));
        let navigation = Request::builder()
            .uri("/api/integrations/google/callback")
            .header("host", "localhost:3000")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "navigate")
            .header("sec-fetch-dest", "document")
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(navigation).await.unwrap();
        assert_eq!(response.status(), StatusCode::FOUND);
        assert_eq!(response.headers()[header::LOCATION], "/");
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("HttpOnly"));
        assert_eq!(
            response.headers()["cross-origin-opener-policy"],
            "same-origin"
        );
        let fetch = Request::builder()
            .uri("/api/integrations/google/callback")
            .header("host", "localhost:3000")
            .header("sec-fetch-site", "cross-site")
            .header("sec-fetch-mode", "cors")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(fetch).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
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
