//! Optional read-only Google Calendar integration.
//! Credentials and recordings remain on this machine; Calendar and the live
//! meeting itself necessarily communicate with Google.
use crate::{security::ApiError, store};
use axum::{
    routing::{get, post},
    Json, Router,
};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::OnceLock, time::Duration};
use tokio::sync::Mutex;
use url::Url;

#[path = "google_oauth.rs"]
mod oauth;
use oauth::{callback, connect};
static TOKEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Default)]
struct CalendarAssociationCache {
    library: PathBuf,
    fetched_at: i64,
    account: Option<String>,
    events: Vec<Value>,
}
static CALENDAR_ASSOCIATIONS: OnceLock<std::sync::Mutex<CalendarAssociationCache>> =
    OnceLock::new();

fn meeting_identity(raw: &str) -> Option<String> {
    if meeting_provider(raw) == "other" {
        return None;
    }
    let mut url = Url::parse(raw).ok()?;
    if meeting_provider(raw) == "zoom" {
        let segments: Vec<_> = url
            .path()
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect();
        if segments.len() >= 2
            && matches!(segments[0], "j" | "wc")
            && segments[1].len() <= 20
            && segments[1].bytes().all(|byte| byte.is_ascii_digit())
        {
            return Some(format!("zoom:{}", segments[1]));
        }
        return None;
    }
    // Query parameters carry admission/account hints, not the meeting identity.
    url.set_query(None);
    if meeting_provider(raw) != "teams" {
        url.set_fragment(None);
    }
    let path = url
        .path()
        .trim_end_matches('/')
        .trim_end_matches("/join")
        .to_string();
    url.set_path(&path);
    Some(url.to_string())
}
fn unique_calendar_event(events: &[Value], raw: &str, recorded_at: &str) -> Option<String> {
    let identity = meeting_identity(raw)?;
    let time = chrono::DateTime::parse_from_rfc3339(recorded_at)
        .ok()?
        .timestamp_millis();
    let mut candidates = events.iter().filter_map(|event| {
        if meeting_identity(event["url"].as_str()?)? != identity {
            return None;
        }
        let start = chrono::DateTime::parse_from_rfc3339(event["start"].as_str()?)
            .ok()?
            .timestamp_millis();
        let end = chrono::DateTime::parse_from_rfc3339(event["end"].as_str()?)
            .ok()?
            .timestamp_millis();
        if end < start || start > time + 15 * 60_000 || end < time - 15 * 60_000 {
            return None;
        }
        event["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 500)
            .map(str::to_owned)
    });
    let id = candidates.next()?;
    if candidates.next().is_some() {
        None
    } else {
        Some(id)
    }
}
/// Only use a fresh Calendar view already fetched by the same local workspace.
/// Ingest never fetches Calendar, exposes its events, or relies on stale/ambiguous matches.
fn cached_calendar_event(
    cache: &CalendarAssociationCache,
    library: &std::path::Path,
    account: &str,
    now: i64,
    raw: &str,
    recorded_at: &str,
) -> Option<String> {
    let age = now - cache.fetched_at;
    if cache.account.as_deref() != Some(account)
        || cache.library != library
        || !(0..=5 * 60_000).contains(&age)
    {
        return None;
    }
    unique_calendar_event(&cache.events, raw, recorded_at)
}
pub(crate) fn associated_calendar_event(raw: &str, recorded_at: &str) -> Option<String> {
    let tokens = read_tokens().ok()??;
    if tokens.reconnect_required || !client_matches(&tokens, &oauth::config().ok()?) {
        return None;
    }
    let current_account = tokens.email?;
    let cache = CALENDAR_ASSOCIATIONS.get()?.lock().ok()?;
    cached_calendar_event(
        &cache,
        &store::data_dir(),
        &current_account,
        Utc::now().timestamp_millis(),
        raw,
        recorded_at,
    )
}

/// Register optional Calendar OAuth and read-only authorization operations.
pub fn routes() -> Router {
    Router::new()
        .route("/integrations/status", get(status))
        .route("/integrations/calendar", get(calendar))
        .route("/integrations/google/connect", get(connect))
        .route("/integrations/google/callback", get(callback))
        .route("/integrations/google/cancel", post(cancel_connection))
        .route(
            "/integrations/google/disconnect",
            post(disconnect).delete(disconnect),
        )
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
    #[serde(default)]
    reconnect_required: bool,
}
/// Locate private Google tokens beneath the active library's credentials folder.
fn credentials_file() -> PathBuf {
    store::data_dir().join("credentials/google.json")
}
/// Read saved Google tokens while distinguishing disconnected state from corrupt credentials.
fn read_tokens() -> Result<Option<Tokens>, ApiError> {
    let invalid = || {
        ApiError::new(
            500,
            "Google credentials could not be read. Disconnect and reconnect your calendar.",
        )
    };
    if fs::symlink_metadata(store::data_dir().join("credentials"))
        .is_ok_and(|metadata| !metadata.is_dir() || metadata.file_type().is_symlink())
    {
        return Err(invalid());
    }
    match fs::symlink_metadata(credentials_file()) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err(invalid()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    let mut reader = store::protected_reader(&credentials_file()).map_err(|_| invalid())?;
    if reader.len() > 1024 * 1024 {
        return Err(invalid());
    }
    let bytes = zeroize::Zeroizing::new(reader.read_all().map_err(|_| invalid())?);
    let tokens: Tokens = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if tokens.access_token.is_empty()
        || tokens
            .refresh_token
            .as_ref()
            .is_some_and(|token| token.is_empty())
    {
        return Err(invalid());
    }
    Ok(Some(tokens))
}
/// Copy validation is local only: authenticate every saved byte and validate
/// the token schema without contacting Google or refreshing the connection.
pub(crate) fn validate_saved_credentials() -> Result<(), ApiError> {
    read_tokens().map(|_| ()).map_err(|_| ApiError::bad("The selected library contains damaged Google credentials. Reconnect Calendar in the original library before copying it. Saved files have not been changed."))
}
/// Atomically publish Google credentials with private file and directory permissions.
fn save_tokens(tokens: &Tokens) -> Result<(), ApiError> {
    store::replace_protected(&credentials_file(), &serde_json::to_vec(tokens)?)
}
/// Create a bounded Google HTTP client that never follows redirects automatically.
fn client(seconds: u64) -> Result<Client, ApiError> {
    Client::builder()
        .timeout(Duration::from_secs(seconds))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ApiError::new(500, "Could not initialize a local integration client."))
}
/// Reject non-local or credential-bearing integration URLs before making requests.
fn loopback_url(raw: &str) -> Result<Url, ApiError> {
    let u = Url::parse(raw)
        .map_err(|_| ApiError::new(503, "The integration URL must be a loopback HTTP URL."))?;
    if !matches!(u.scheme(), "http" | "https")
        || !matches!(
            u.host_str(),
            Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
        )
        || !u.username().is_empty()
        || u.password().is_some()
    {
        return Err(ApiError::new(
            503,
            "Local integrations must use this computer's loopback address.",
        ));
    }
    Ok(u)
}
/// Require a successful Google response and return concise errors on service failures.
async fn google_response(
    response: Result<reqwest::Response, reqwest::Error>,
) -> Result<Value, ApiError> {
    google_response_bounded(response, 16 * 1024 * 1024, false).await
}
async fn oauth_response(
    response: Result<reqwest::Response, reqwest::Error>,
) -> Result<Value, ApiError> {
    google_response_bounded(response, 1024 * 1024, true).await
}
/// Only these fixed classifications can leave the token exchange. Never echo
/// Google's raw body, description, request parameters, or token/code material.
fn oauth_error(bytes: &[u8]) -> ApiError {
    let value: Value = serde_json::from_slice(bytes).unwrap_or(Value::Null);
    let code = value["error"].as_str().unwrap_or_default();
    let missing_secret = value["error_description"]
        .as_str()
        .is_some_and(|description| {
            let description = description.trim().trim_end_matches('.');
            description.eq_ignore_ascii_case("client_secret is missing")
                || description.eq_ignore_ascii_case("missing required parameter: client_secret")
        });
    match code {
        "invalid_request" if missing_secret => ApiError::new(503, "Google requires additional publisher configuration for this Desktop OAuth client (client_secret_required). Your previous connection has not been changed."),
        "invalid_client" => ApiError::new(503, "Google rejected this build's OAuth client configuration (invalid_client). Ask the publisher for an updated build. Your previous connection has not been changed."),
        "unauthorized_client" => ApiError::new(503, "Google has not authorized this OAuth client for the requested flow (unauthorized_client). Ask the publisher to check its configuration."),
        "invalid_grant" => ApiError::new(401, "Google rejected the authorization code or refresh grant (invalid_grant). Connect your calendar again."),
        "invalid_request" => ApiError::new(503, "Google rejected the OAuth request configuration (invalid_request). Ask the publisher to check this build. Your previous connection has not been changed."),
        "redirect_uri_mismatch" => ApiError::new(503, "Google rejected the OAuth callback configuration (redirect_uri_mismatch). Ask the publisher to check this build."),
        "invalid_scope" => ApiError::new(503, "Google rejected this build's requested Calendar permissions (invalid_scope). Ask the publisher to check its configuration."),
        "unsupported_grant_type" => ApiError::new(503, "Google rejected this build's authorization flow (unsupported_grant_type). Ask the publisher to check its configuration."),
        "access_denied" => ApiError::new(403, "Google declined Calendar authorization (access_denied). Your previous connection has not been changed."),
        "temporarily_unavailable" | "server_error" => ApiError::new(503, "Google authorization is temporarily unavailable (oauth_service_unavailable). Retry shortly."),
        _ => ApiError::new(502, "Google rejected the authorization request (oauth_response_unrecognized). No response details were retained. Your previous connection has not been changed."),
    }
}
async fn bounded_oauth_error(mut response: reqwest::Response) -> ApiError {
    const LIMIT: usize = 16 * 1024;
    if response
        .content_length()
        .is_some_and(|bytes| bytes > LIMIT as u64)
    {
        return oauth_error(&[]);
    }
    let mut bytes = zeroize::Zeroizing::new(Vec::new());
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) if bytes.len() + chunk.len() <= LIMIT => {
                bytes.extend_from_slice(&chunk)
            }
            Ok(None) => return oauth_error(&bytes),
            _ => return oauth_error(&[]),
        }
    }
}
async fn google_response_bounded(
    response: Result<reqwest::Response, reqwest::Error>,
    limit: usize,
    diagnose_oauth: bool,
) -> Result<Value, ApiError> {
    let mut response = response.map_err(|_| {
        ApiError::new(
            502,
            "Google could not be reached. Check your connection and retry.",
        )
    })?;
    match response.status().as_u16() {
        200..=299 => {
            let invalid = || ApiError::new(502,"Google returned an invalid response. Retry shortly.");
            if response.content_length().is_some_and(|bytes|bytes > limit as u64) { return Err(invalid()); }
            let mut bytes = zeroize::Zeroizing::new(Vec::new());
            while let Some(chunk) = response.chunk().await.map_err(|_|invalid())? {
                if bytes.len() + chunk.len() > limit { return Err(invalid()); }
                bytes.extend_from_slice(&chunk);
            }
            serde_json::from_slice(&bytes).map_err(|_|invalid())
        },
        400 | 401 if diagnose_oauth => Err(bounded_oauth_error(response).await),
        400 | 401 => Err(ApiError::new(401,"Google authorization expired or was declined. Reconnect your calendar.")),
        403 => Err(ApiError::new(403,"Google Calendar access was denied. Enable the Calendar API and grant calendar read access.")),
        429 => Err(ApiError::new(429,"Google Calendar is temporarily rate limited. Retry shortly.")),
        _ => Err(ApiError::new(502,"Google Calendar is unavailable. Retry shortly.")),
    }
}
/// Exchange the verified code without committing anything until the owned
/// session checks cancellation and expiry again.
async fn exchange_authorization(
    c: &oauth::Config,
    code: &str,
    verifier: &str,
) -> Result<Tokens, ApiError> {
    let client = client(20)?;
    let mut form = vec![
        ("client_id", c.id.as_str()),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", c.redirect.as_str()),
        ("grant_type", "authorization_code"),
    ];
    if let Some(secret) = &c.secret {
        form.push(("client_secret", secret.as_str()));
    }
    let token = oauth_response(client.post(c.token_url()).form(&form).send().await).await?;
    if token["scope"].as_str().is_some_and(|scope| {
        !scope
            .split_whitespace()
            .any(|value| value == "https://www.googleapis.com/auth/calendar.readonly")
    }) {
        return Err(ApiError::new(403, "Calendar read-only access was not granted. Your previous connection has not been changed."));
    }
    let access = token["access_token"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 65_536)
        .ok_or_else(|| ApiError::new(502, "Google did not return a valid access token."))?;
    let profile =
        oauth_response(client.get(c.profile_url()).bearer_auth(access).send().await).await?;
    Ok(Tokens {
        access_token: access.to_owned(),
        refresh_token: token["refresh_token"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(str::to_owned),
        expires_at: expiry(&token)?,
        email: profile["email"].as_str().map(str::to_owned),
        client_id: Some(c.id.clone()),
        reconnect_required: false,
    })
}
fn expiry(token: &Value) -> Result<i64, ApiError> {
    let seconds = token["expires_in"].as_i64().unwrap_or(3600);
    if !(1..=86_400).contains(&seconds) {
        return Err(ApiError::new(
            502,
            "Google returned an invalid token lifetime.",
        ));
    }
    Ok(Utc::now().timestamp_millis() + seconds * 1000)
}
fn client_matches(tokens: &Tokens, config: &oauth::Config) -> bool {
    match &tokens.client_id {
        Some(id) => id == &config.id,
        None => !config.installed,
    }
}
async fn cancel_connection() -> Json<Value> {
    Json(json!({"cancelled":oauth::cancel()}))
}
pub(crate) fn shutdown() {
    oauth::cancel();
}
/// Delete saved Google credentials while retaining meeting data.
async fn disconnect() -> Result<Json<Value>, ApiError> {
    oauth::cancel();
    if let Some(cache) = CALENDAR_ASSOCIATIONS.get() {
        if let Ok(mut cache) = cache.lock() {
            *cache = CalendarAssociationCache::default();
        }
    }
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    match fs::remove_file(credentials_file()) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    Ok(Json(json!({"disconnected":true})))
}
/// Refresh only credentials issued to the configured OAuth client. Legacy
/// source credentials remain usable in source mode; installed copies reconnect.
async fn access_token() -> Result<Tokens, ApiError> {
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let saved = read_tokens()?
        .ok_or_else(|| ApiError::new(401, "Connect Google Calendar to see your meetings."))?;
    let config = oauth::config()?;
    refresh_token(saved, &config).await
}
async fn refresh_token(mut saved: Tokens, c: &oauth::Config) -> Result<Tokens, ApiError> {
    if saved.reconnect_required || !client_matches(&saved, c) {
        return Err(ApiError::new(401, "Reconnect Calendar in this Echo build. Your previous connection is preserved until a new connection succeeds."));
    }
    if saved.expires_at > Utc::now().timestamp_millis() + 60_000 {
        return Ok(saved);
    }
    let Some(refresh) = saved.refresh_token.as_deref() else {
        saved.reconnect_required = true;
        save_tokens(&saved)?;
        return Err(ApiError::new(
            401,
            "Reconnect Google Calendar to renew access.",
        ));
    };
    let mut form = vec![
        ("client_id", c.id.as_str()),
        ("refresh_token", refresh),
        ("grant_type", "refresh_token"),
    ];
    if let Some(secret) = &c.secret {
        form.push(("client_secret", secret.as_str()));
    }
    let result = oauth_response(client(20)?.post(c.token_url()).form(&form).send().await).await;
    let token = match result {
        Ok(value) => value,
        Err(error) => {
            if error.status == axum::http::StatusCode::UNAUTHORIZED {
                saved.reconnect_required = true;
                save_tokens(&saved)?;
            }
            return Err(error);
        }
    };
    saved.access_token = token["access_token"]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 65_536)
        .ok_or_else(|| {
            ApiError::new(
                502,
                "Google could not renew access. Reconnect your calendar.",
            )
        })?
        .to_owned();
    if let Some(refresh) = token["refresh_token"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        saved.refresh_token = Some(refresh.into());
    }
    saved.expires_at = expiry(&token)?;
    saved.client_id = Some(c.id.clone());
    save_tokens(&saved)?;
    Ok(saved)
}
/// Classify recognized conferencing hosts without implying automatic meeting attendance.
fn meeting_provider(raw: &str) -> &'static str {
    let Ok(url) = Url::parse(raw) else {
        return "other";
    };
    if url.scheme() != "https" {
        return "other";
    }
    match url.host_str().unwrap_or_default() {
        "meet.google.com" => "google-meet",
        "teams.microsoft.com" | "teams.live.com" | "teams.cloud.microsoft" => "teams",
        h if h == "app.zoom.com" || h == "zoom.us" || h.ends_with(".zoom.us") => "zoom",
        _ => "other",
    }
}
/// Find a Calendar event's conferencing destination from structured fields or description text.
fn event_url(event: &Value) -> Option<String> {
    let mut candidates = Vec::new();
    if let Some(url) = event["hangoutLink"].as_str() {
        candidates.push(url.to_owned());
    }
    if let Some(entries) = event["conferenceData"]["entryPoints"].as_array() {
        for item in entries {
            if item["entryPointType"] == "video" {
                if let Some(url) = item["uri"].as_str() {
                    candidates.push(url.to_owned());
                }
            }
        }
    }
    for field in ["location", "description"] {
        if let Some(text) = event[field].as_str() {
            // Calendar descriptions often include HTML anchor tags. Extract only known HTTPS meeting hosts.
            for tail in text.split("https://").skip(1) {
                let suffix = tail
                    .split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | '"' | '\''))
                    .next()
                    .unwrap_or_default();
                candidates.push(format!("https://{suffix}"));
            }
        }
    }
    candidates
        .into_iter()
        .find(|u| meeting_provider(u) != "other")
}
/// Expose the event fields needed by the local calendar UI.
fn normalize_event(event: &Value) -> Option<Value> {
    if event["status"] == "cancelled" {
        return None;
    }
    let id = event["id"].as_str()?;
    let start = event["start"]["dateTime"]
        .as_str()
        .or_else(|| event["start"]["date"].as_str())?;
    let end = event["end"]["dateTime"]
        .as_str()
        .or_else(|| event["end"]["date"].as_str())?;
    let url = event_url(event);
    let mut value = json!({"id":id,"title":event["summary"].as_str().unwrap_or("Untitled meeting"),"start":start,"end":end,"provider":url.as_deref().map(meeting_provider).unwrap_or("other"),"attendees":event["attendees"].as_array().map(Vec::len).unwrap_or(0)});
    if let Some(url) = url {
        value["url"] = json!(url);
    }
    Some(value)
}
fn mark_revoked(access: &str) -> Result<(), ApiError> {
    if let Some(mut current) = read_tokens()? {
        if current.access_token == access {
            current.reconnect_required = true;
            save_tokens(&current)?;
        }
    }
    Ok(())
}
/// Fetch the upcoming calendar window using a connected Google account.
async fn calendar() -> Result<Json<Value>, ApiError> {
    let tokens = access_token().await?;
    let start = (Utc::now() - ChronoDuration::hours(1)).to_rfc3339();
    let end = (Utc::now() + ChronoDuration::days(30)).to_rfc3339();
    let mut url =
        Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("timeMin", start.as_str()),
        ("timeMax", end.as_str()),
        ("singleEvents", "true"),
        ("orderBy", "startTime"),
        ("maxResults", "250"),
    ]);
    let account = tokens.email.clone();
    let result = google_response(
        client(20)?
            .get(url)
            .bearer_auth(&tokens.access_token)
            .send()
            .await,
    )
    .await;
    let data = match result {
        Ok(value) => value,
        Err(error) => {
            if error.status == axum::http::StatusCode::UNAUTHORIZED {
                let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
                mark_revoked(&tokens.access_token)?;
            }
            return Err(error);
        }
    };
    let events: Vec<Value> = data["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(normalize_event)
        .collect();
    if let Ok(mut cache) = CALENDAR_ASSOCIATIONS
        .get_or_init(|| std::sync::Mutex::new(CalendarAssociationCache::default()))
        .lock()
    {
        *cache = CalendarAssociationCache {
            library: store::data_dir(), fetched_at: Utc::now().timestamp_millis(), account,
            events: events.iter().map(|event| json!({"id":event["id"],"url":event["url"],"start":event["start"],"end":event["end"]})).collect(),
        };
    }
    Ok(Json(json!({"events":events})))
}

/// Report Calendar connection without exposing its credentials.
async fn status() -> Result<Json<Value>, ApiError> {
    let tokens = read_tokens()?;
    let config = oauth::config();
    let reconnect = tokens.as_ref().is_some_and(|tokens| {
        tokens.reconnect_required || config.as_ref().is_ok_and(|c| !client_matches(tokens, c))
    });
    let connected = tokens.is_some() && config.is_ok() && !reconnect;
    let mut google = json!({"configured":config.is_ok(),"connected":connected,"mode":if crate::paths::installed(){"installed"}else{"source"},"pending":oauth::pending(),"reconnectRequired":reconnect});
    if let Err(error) = config {
        google["configurationError"] = json!(error.message);
    }
    if let Some(email) = tokens.and_then(|t| t.email) {
        google["email"] = json!(email);
    }
    Ok(Json(json!({"google":google})))
}
#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        extract::Query,
        http::{header, HeaderMap, HeaderValue},
    };
    use oauth::cookie_value;
    use std::collections::HashMap;
    #[test]
    fn oauth_diagnostics_expose_only_allowlisted_classifications() {
        for (code, status) in [
            ("invalid_client", 503),
            ("invalid_grant", 401),
            ("invalid_request", 503),
            ("unauthorized_client", 503),
            ("redirect_uri_mismatch", 503),
            ("invalid_scope", 503),
            ("unsupported_grant_type", 503),
            ("access_denied", 403),
        ] {
            let error=oauth_error(&serde_json::to_vec(&json!({"error":code,"error_description":"synthetic-private-code-and-token","access_token":"synthetic-private-access"})).unwrap());
            assert_eq!(error.status.as_u16(), status);
            assert!(error.message.contains(code));
            assert!(!error.message.contains("synthetic-private"));
        }
        let missing = oauth_error(
            br#"{"error":"invalid_request","error_description":"client_secret is missing."}"#,
        );
        assert_eq!(missing.status.as_u16(), 503);
        assert!(missing.message.contains("client_secret_required"));
        for body in [
            b"not-json synthetic-private-code".as_slice(),
            br#"{"error":"synthetic-private-code","error_description":"synthetic-private-token"}"#,
            br#"{"error":{"message":"synthetic-private-token"}}"#,
        ] {
            let error = oauth_error(body);
            assert!(error.message.contains("oauth_response_unrecognized"));
            assert!(!error.message.contains("synthetic-private"));
        }
    }
    #[tokio::test]
    async fn oauth_error_http_body_is_bounded_and_never_echoed() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let body = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let output = body.clone();
        let router = Router::new().route(
            "/",
            get(move || {
                let output = output.clone();
                async move {
                    (
                        axum::http::StatusCode::BAD_REQUEST,
                        output.lock().unwrap().clone(),
                    )
                }
            }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        for (value, expected) in [
            (
                json!({"error":"invalid_request","error_description":"client_secret is missing."})
                    .to_string(),
                "client_secret_required",
            ),
            (
                json!({"error":"invalid_client","error_description":"synthetic-private-response"})
                    .to_string(),
                "invalid_client",
            ),
            (
                "synthetic-private-response".repeat(1024),
                "oauth_response_unrecognized",
            ),
            (
                "synthetic-private-malformed".into(),
                "oauth_response_unrecognized",
            ),
        ] {
            *body.lock().unwrap() = value;
            let error = oauth_response(
                client(2)
                    .unwrap()
                    .get(format!("http://{address}/"))
                    .send()
                    .await,
            )
            .await
            .unwrap_err();
            assert!(error.message.contains(expected));
            assert!(!error.message.contains("synthetic-private"));
        }
        server.abort();
    }
    #[test]
    fn google_credentials_are_authenticated_at_rest_and_never_fall_back_to_json() {
        let _guard = store::TEST_LIBRARY_LOCK.blocking_lock();
        let directory = store::test_directory();
        store::reset_for_tests();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        let tokens = Tokens {
            access_token: "private-oauth-access".into(),
            refresh_token: Some("private-oauth-refresh".into()),
            expires_at: 42,
            email: Some("private@example.test".into()),
            client_id: None,
            reconnect_required: false,
        };
        save_tokens(&tokens).unwrap();
        let original = fs::read(credentials_file()).unwrap();
        assert!(original.starts_with(b"ECHOENC1"));
        assert!(!String::from_utf8_lossy(&original).contains("private-oauth"));
        assert_eq!(
            read_tokens().unwrap().unwrap().access_token,
            tokens.access_token
        );
        let mut changed = original.clone();
        changed[70] ^= 1;
        fs::write(credentials_file(), &changed).unwrap();
        assert!(read_tokens().is_err());
        assert_eq!(fs::read(credentials_file()).unwrap(), changed);
        fs::write(credentials_file(), serde_json::to_vec(&tokens).unwrap()).unwrap();
        assert!(read_tokens().is_err());
        save_tokens(&tokens).unwrap();
        assert_eq!(
            read_tokens().unwrap().unwrap().refresh_token,
            tokens.refresh_token
        );
        assert!(fs::read_dir(credentials_file().parent().unwrap())
            .unwrap()
            .all(|entry| entry.unwrap().file_name() == "google.json"));
        store::reset_for_tests();
        std::env::remove_var("ECHO_DATA_DIR");
    }
    #[test]
    fn calendar_association_requires_one_matching_current_event() {
        let event = json!({"id":"event-one","url":"https://meet.google.com/aaa-bbbb-ccc?authuser=1","start":"2026-10-05T10:00:00Z","end":"2026-10-05T11:00:00Z"});
        let time = "2026-10-05T10:05:00Z";
        assert_eq!(
            unique_calendar_event(
                std::slice::from_ref(&event),
                "https://meet.google.com/aaa-bbbb-ccc",
                time
            ),
            Some("event-one".into())
        );
        assert_eq!(
            unique_calendar_event(
                &[event.clone(), event.clone()],
                "https://meet.google.com/aaa-bbbb-ccc",
                time
            ),
            None
        );
        assert_eq!(
            unique_calendar_event(
                std::slice::from_ref(&event),
                "https://meet.google.com/ddd-eeee-fff",
                time
            ),
            None
        );
        assert_eq!(
            unique_calendar_event(
                std::slice::from_ref(&event),
                "https://meet.google.com/aaa-bbbb-ccc",
                "2026-10-05T12:00:00Z"
            ),
            None
        );
        assert_eq!(
            unique_calendar_event(&[event], "https://hostile.example/aaa-bbbb-ccc", time),
            None
        );
        let zoom_event = json!({"id":"zoom-event","url":"https://company.zoom.us/j/123456789?pwd=synthetic","start":"2026-10-05T10:00:00Z","end":"2026-10-05T11:00:00Z"});
        assert_eq!(
            unique_calendar_event(
                std::slice::from_ref(&zoom_event),
                "https://app.zoom.com/wc/123456789/join",
                time
            ),
            Some("zoom-event".into())
        );
        assert_eq!(
            unique_calendar_event(
                std::slice::from_ref(&zoom_event),
                "https://app.zoom.com/wc/987654321/join",
                time
            ),
            None
        );
        assert_eq!(
            meeting_identity("https://app.zoom.com/profile/123456789"),
            None
        );
        let cache = CalendarAssociationCache {
            library: PathBuf::from("library"),
            fetched_at: 1000,
            account: Some("authorized-account".into()),
            events: vec![
                json!({"id":"event-one","url":"https://meet.google.com/aaa-bbbb-ccc","start":"2026-10-05T10:00:00Z","end":"2026-10-05T11:00:00Z"}),
            ],
        };
        let library = std::path::Path::new("library");
        let url = "https://meet.google.com/aaa-bbbb-ccc";
        assert_eq!(
            cached_calendar_event(&cache, library, "authorized-account", 1000, url, time),
            Some("event-one".into())
        );
        assert_eq!(
            cached_calendar_event(&cache, library, "another-account", 1000, url, time),
            None
        );
        assert_eq!(
            cached_calendar_event(
                &cache,
                std::path::Path::new("other-library"),
                "authorized-account",
                1000,
                url,
                time
            ),
            None
        );
        assert_eq!(
            cached_calendar_event(&cache, library, "authorized-account", 302000, url, time),
            None
        );
        assert_eq!(
            cached_calendar_event(&cache, library, "authorized-account", 0, url, time),
            None
        );
    }
    #[test]
    fn callback_destinations_cannot_escape_loopback() {
        for bad in [
            "http://169.254.169.254",
            "https://localhost.attacker.test",
            "http://user:pass@localhost",
            "file:///etc/passwd",
        ] {
            assert!(loopback_url(bad).is_err(), "{bad}");
        }
        assert!(loopback_url("http://127.0.0.1:8765").is_ok());
    }
    #[test]
    fn events_have_honest_providers_and_dates() {
        assert!(normalize_event(&json!({"status":"cancelled"})).is_none());
        let event=normalize_event(&json!({"id":"e","start":{"date":"2026-10-04"},"end":{"date":"2026-10-05"},"description":"<a href=\"https://us02web.zoom.us/j/123\">Join</a>"})).unwrap();
        assert_eq!(event["provider"], "zoom");
        assert_eq!(event["url"], "https://us02web.zoom.us/j/123");
        assert_eq!(event["title"], "Untitled meeting");
        assert_eq!(meeting_provider("https://zoom.us.evil.test/j/123"), "other");
        assert_eq!(
            meeting_provider("http://meet.google.com/abc-defg-hij"),
            "other"
        );
    }
    #[tokio::test]
    async fn callback_without_valid_state_clears_cookie_and_returns_an_error() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let response = callback(
            HeaderMap::new(),
            Query(HashMap::from([("code".into(), "untrusted".into())])),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::SEE_OTHER);
        assert!(response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("calendar=error"));
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
    }
    #[test]
    fn cookie_parser_does_not_accept_substring_matches() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("not_echo_google_oauth=attacker; echo_google_oauth=actual"),
        );
        assert_eq!(cookie_value(&headers).unwrap(), "actual");
    }
}
