//! Google Calendar OAuth and an explicitly configured local Google Meet runner.
//! Credentials and recordings remain on this machine; Calendar and the live
//! meeting itself necessarily communicate with Google.
use crate::{security::ApiError, store};
use axum::{
    extract::Query,
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::OnceLock,
    time::Duration,
};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

const COOKIE: &str = "echo_google_oauth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const MAX_AUDIO: usize = 512 * 1024 * 1024;
const BOT_IMPORT_CHUNK_BYTES: usize = 64 * 1024 * 1024;
static TOKEN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static BOT_START_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static RUNNER_AUTH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
const MAX_RUNNER_JSON: usize = 64 * 1024;
const MAX_AUTH_SCREEN: usize = 2 * 1024 * 1024;

/// Register optional Calendar OAuth and authenticated local recorder operations.
pub fn routes() -> Router {
    Router::new()
        .route("/integrations/status", get(status))
        .route("/integrations/calendar", get(calendar))
        .route("/integrations/google/connect", get(connect))
        .route("/integrations/google/callback", get(callback))
        .route(
            "/integrations/google/disconnect",
            post(disconnect).delete(disconnect),
        )
        .route(
            "/integrations/bot",
            get(bot_status).post(bot_start).delete(bot_stop),
        )
        .route("/integrations/bot/audio", get(bot_audio))
        .route("/integrations/bot/import", post(bot_import))
        .route(
            "/integrations/runner/auth",
            get(runner_auth_status)
                .post(runner_auth_start)
                .delete(runner_auth_delete),
        )
        .route("/integrations/runner/auth/finish", post(runner_auth_finish))
        .route("/integrations/runner/auth/cancel", post(runner_auth_cancel))
        .route("/integrations/runner/auth/screen", get(runner_auth_screen))
        .route("/integrations/runner/auth/input", post(runner_auth_input))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Tokens {
    access_token: String,
    refresh_token: Option<String>,
    expires_at: i64,
    email: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct OAuthState {
    state: String,
    verifier: String,
    created_at: i64,
}
struct GoogleConfig {
    id: String,
    secret: String,
    redirect: String,
}
/// Combine Google OAuth credentials with the callback address in shared runtime config.
fn google_config() -> GoogleConfig {
    GoogleConfig {
        id: std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default(),
        secret: std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default(),
        redirect: crate::config::get().google_redirect_uri.clone(),
    }
}
/// Require both OAuth credentials before presenting Calendar connection as available.
fn google_configured() -> bool {
    let c = google_config();
    !c.id.is_empty() && !c.secret.is_empty()
}
/// Locate private Google tokens beneath the active library's credentials folder.
fn credentials_file() -> PathBuf {
    store::data_dir().join("credentials/google.json")
}
/// Read saved Google tokens while distinguishing disconnected state from corrupt credentials.
fn read_tokens() -> Result<Option<Tokens>, ApiError> {
    match fs::read(credentials_file()) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            ApiError::new(
                500,
                "Google credentials could not be read. Disconnect and reconnect your calendar.",
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
/// Atomically publish Google credentials with private file and directory permissions.
fn save_tokens(tokens: &Tokens) -> Result<(), ApiError> {
    let file = credentials_file();
    let parent = file.parent().unwrap();
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let temporary = parent.join(format!("google.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut out = options.open(&temporary)?;
        out.write_all(&serde_json::to_vec(tokens)?)?;
        out.sync_all()?;
        fs::rename(&temporary, &file)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
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
/// Generate unpredictable material for the OAuth state and PKCE verifier.
fn random_secret() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}
/// Build the Calendar authorization URL and its short-lived state cookie.
fn authorization() -> Result<(String, String, bool), ApiError> {
    if !google_configured() {
        return Err(ApiError::new(503, "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart Echo Voice. See docs/integrations.md."));
    }
    let c = google_config();
    let callback = loopback_url(&c.redirect)?;
    let state = OAuthState {
        state: random_secret(),
        verifier: random_secret(),
        created_at: Utc::now().timestamp_millis(),
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(state.verifier.as_bytes()));
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut().extend_pairs([
        ("client_id", c.id.as_str()),
        ("redirect_uri", c.redirect.as_str()),
        ("response_type", "code"),
        (
            "scope",
            "openid email https://www.googleapis.com/auth/calendar.readonly",
        ),
        ("access_type", "offline"),
        ("prompt", "select_account consent"),
        ("state", state.state.as_str()),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge.as_str()),
    ]);
    Ok((
        url.to_string(),
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&state)?),
        callback.scheme() == "https",
    ))
}
/// Require a matching unexpired state cookie before accepting an OAuth callback.
fn validate_state(cookie: Option<&str>, received: Option<&str>) -> Result<String, ApiError> {
    let failure =
        || ApiError::bad("Calendar security check failed or expired. Connect your calendar again.");
    let bytes = URL_SAFE_NO_PAD
        .decode(cookie.ok_or_else(failure)?)
        .map_err(|_| failure())?;
    let parsed: OAuthState = serde_json::from_slice(&bytes).map_err(|_| failure())?;
    let received = received.ok_or_else(failure)?;
    let age = Utc::now().timestamp_millis() - parsed.created_at;
    if !(0..=600_000).contains(&age)
        || parsed.state.len() != received.len()
        || parsed
            .state
            .as_bytes()
            .iter()
            .zip(received.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            != 0
    {
        return Err(failure());
    }
    Ok(parsed.verifier)
}
/// Extract the exact OAuth cookie name without accepting substring matches.
fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (k, v) = part.trim().split_once('=')?;
            (k == COOKIE).then(|| v.to_owned())
        })
}
/// Normalize the callback host and redirect into Google's consent flow.
async fn connect(headers: HeaderMap) -> Result<Response, ApiError> {
    // Keep the state cookie on the same loopback host as Google's callback.
    // A user may open 127.0.0.1 while their OAuth client names localhost.
    let callback = loopback_url(&google_config().redirect)?;
    let callback_origin = callback.origin().ascii_serialization();
    let expected_host = callback_origin
        .split_once("://")
        .map(|(_, host)| host)
        .unwrap_or_default();
    if headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|host| host != expected_host)
    {
        return Ok(Redirect::to(&format!(
            "{callback_origin}/api/integrations/google/connect"
        ))
        .into_response());
    }
    let (url, cookie, secure) = authorization()?;
    let mut response = Redirect::to(&url).into_response();
    let value = format!(
        "{COOKIE}={cookie}; Path=/api/integrations/google; HttpOnly; SameSite=Lax; Max-Age=600{}",
        if secure { "; Secure" } else { "" }
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&value)
            .map_err(|_| ApiError::new(500, "Could not begin calendar authorization."))?,
    );
    Ok(response)
}
/// Require a successful Google response and return concise errors on service failures.
async fn google_response(
    response: Result<reqwest::Response, reqwest::Error>,
) -> Result<Value, ApiError> {
    let response = response.map_err(|_| {
        ApiError::new(
            502,
            "Google could not be reached. Check your connection and retry.",
        )
    })?;
    match response.status().as_u16() {
        200..=299 => response.json().await.map_err(|_|ApiError::new(502,"Google returned an invalid response. Retry shortly.")),
        400 | 401 => Err(ApiError::new(401,"Google authorization expired or was declined. Reconnect your calendar.")),
        403 => Err(ApiError::new(403,"Google Calendar access was denied. Enable the Calendar API and grant calendar read access.")),
        429 => Err(ApiError::new(429,"Google Calendar is temporarily rate limited. Retry shortly.")),
        _ => Err(ApiError::new(502,"Google Calendar is unavailable. Retry shortly.")),
    }
}
/// Exchange the verified OAuth code and persist the resulting account tokens.
async fn finish_authorization(code: &str, verifier: &str) -> Result<(), ApiError> {
    let _auth_guard = RUNNER_AUTH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let c = google_config();
    if !google_configured() {
        return Err(ApiError::new(503, "Google Calendar is not configured."));
    }
    let client = client(20)?;
    let token = google_response(
        client
            .post(TOKEN_URL)
            .form(&[
                ("client_id", c.id.as_str()),
                ("client_secret", c.secret.as_str()),
                ("code", code),
                ("code_verifier", verifier),
                ("redirect_uri", c.redirect.as_str()),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await,
    )
    .await?;
    let access = token["access_token"]
        .as_str()
        .ok_or_else(|| ApiError::new(502, "Google did not return an access token."))?;
    let profile = google_response(
        client
            .get("https://openidconnect.googleapis.com/v1/userinfo")
            .bearer_auth(access)
            .send()
            .await,
    )
    .await?;
    if read_tokens()?.and_then(|t| t.email).as_deref() != profile["email"].as_str() {
        let _ = cancel_interactive_auth().await;
    }
    save_tokens(&Tokens {
        access_token: access.to_owned(),
        refresh_token: token["refresh_token"].as_str().map(str::to_owned),
        expires_at: Utc::now().timestamp_millis()
            + token["expires_in"].as_i64().unwrap_or(3600) * 1000,
        email: profile["email"].as_str().map(str::to_owned),
    })
}
/// Complete a state-checked callback and clear the one-use cookie on success or failure.
async fn callback(headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    let result = async {
        let cookie = cookie_value(&headers);
        let verifier = validate_state(cookie.as_deref(), query.get("state").map(String::as_str))?;
        if query.contains_key("error") {
            return Err(ApiError::bad(
                "Calendar access was declined. You can connect again when ready.",
            ));
        }
        let code = query
            .get("code")
            .filter(|s| !s.is_empty() && s.len() <= 4096)
            .ok_or_else(|| {
                ApiError::bad("Google did not return an authorization code. Try connecting again.")
            })?;
        finish_authorization(code, &verifier).await
    }
    .await;
    let target = match result {
        Ok(()) => "/?calendar=connected".to_owned(),
        Err(error) => format!(
            "/?{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair("calendar", "error")
                .append_pair("message", &error.message)
                .finish()
        ),
    };
    let mut response = Redirect::to(&target).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "echo_google_oauth=; Path=/api/integrations/google; HttpOnly; SameSite=Lax; Max-Age=0",
        ),
    );
    response
}
/// Delete saved Google credentials while retaining meeting data.
async fn disconnect() -> Result<Json<Value>, ApiError> {
    let _auth_guard = RUNNER_AUTH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    // A saved browser profile remains separate from Calendar authorization.
    // End only the interactive login; an offline runner cannot be controlled.
    let cancelled = cancel_interactive_auth().await;
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    match fs::remove_file(credentials_file()) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(e.into()),
    }
    Ok(Json(
        json!({"disconnected":true,"runnerLoginCancelled":cancelled}),
    ))
}
/// Refresh expired Google access tokens under a lock and preserve the refresh credential.
async fn access_token() -> Result<Tokens, ApiError> {
    let _guard = TOKEN_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let mut saved = read_tokens()?
        .ok_or_else(|| ApiError::new(401, "Connect Google Calendar to see your meetings."))?;
    if saved.expires_at > Utc::now().timestamp_millis() + 60_000 {
        return Ok(saved);
    }
    let refresh = saved
        .refresh_token
        .as_deref()
        .ok_or_else(|| ApiError::new(401, "Reconnect Google Calendar to renew access."))?;
    let c = google_config();
    let token = google_response(
        client(20)?
            .post(TOKEN_URL)
            .form(&[
                ("client_id", c.id.as_str()),
                ("client_secret", c.secret.as_str()),
                ("refresh_token", refresh),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await,
    )
    .await?;
    saved.access_token = token["access_token"]
        .as_str()
        .ok_or_else(|| {
            ApiError::new(
                502,
                "Google could not renew access. Reconnect your calendar.",
            )
        })?
        .to_owned();
    if let Some(refresh) = token["refresh_token"].as_str() {
        saved.refresh_token = Some(refresh.into());
    }
    saved.expires_at =
        Utc::now().timestamp_millis() + token["expires_in"].as_i64().unwrap_or(3600) * 1000;
    save_tokens(&saved)?;
    Ok(saved)
}
/// Classify recognized conferencing hosts without implying unsupported runner capabilities.
fn meeting_provider(raw: &str) -> &'static str {
    let Ok(url) = Url::parse(raw) else {
        return "other";
    };
    if url.scheme() != "https" {
        return "other";
    }
    match url.host_str().unwrap_or_default() {
        "meet.google.com" => "google-meet",
        "teams.microsoft.com" | "teams.live.com" => "teams",
        h if h == "zoom.us" || h.ends_with(".zoom.us") => "zoom",
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
    let data = google_response(
        client(20)?
            .get(url)
            .bearer_auth(tokens.access_token)
            .send()
            .await,
    )
    .await?;
    let events: Vec<Value> = data["items"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(normalize_event)
        .collect();
    Ok(Json(json!({"events":events})))
}

/// Reject missing or path-unsafe meeting and recording-start identifiers.
fn validate_id(raw: Option<&str>) -> Result<&str, ApiError> {
    let id = raw.ok_or_else(|| ApiError::bad("A valid meeting ID is required."))?;
    if id.is_empty()
        || id.len() > 100
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(ApiError::bad("A valid meeting ID is required."));
    }
    Ok(id)
}
/// Canonicalize standard Google Meet codes and reject other conferencing destinations.
fn validate_meet_url(raw: &str) -> Result<String, ApiError> {
    let fail = || {
        ApiError::new(422,"The local runner supports standard Google Meet links only. Zoom and Teams are not available.")
    };
    let url = Url::parse(raw).map_err(|_| fail())?;
    let p = url.path().trim_end_matches('/');
    let bytes = p.as_bytes();
    let valid_code = bytes.len() == 13
        && bytes[0] == b'/'
        && bytes[4] == b'-'
        && bytes[9] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 0 | 4 | 9) || b.is_ascii_lowercase());
    if url.scheme() != "https"
        || url.host_str() != Some("meet.google.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !valid_code
    {
        return Err(fail());
    }
    Ok(format!("https://meet.google.com{p}"))
}
/// Read the configured loopback runner address and its generated per-library credential.
fn runner_config() -> Result<(String, String), ApiError> {
    let raw = crate::config::get().runner.url.clone();
    let url = loopback_url(&raw)?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(ApiError::new(
            503,
            "The local runner URL must contain only its loopback address and port.",
        ));
    }
    Ok((
        url.origin().ascii_serialization(),
        crate::config::runner_token(&store::data_dir())?,
    ))
}
/// Call the local runner directly with bearer authentication, no proxy, and no redirects.
async fn runner_request(
    method: Method,
    endpoint: &str,
    body: Option<Value>,
    timeout: u64,
) -> Result<reqwest::Response, ApiError> {
    let (origin, token) = runner_config()?;
    let direct = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ApiError::new(500, "Could not initialize the local runner client."))?;
    let mut request = direct
        .request(method, format!("{origin}{endpoint}"))
        .bearer_auth(token);
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request.send().await.map_err(|_| {
        ApiError::new(
            503,
            "The local meeting runner is offline. Start it on this computer, then retry.",
        )
    })?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let data: Value =
            serde_json::from_slice(&bounded_runner_bytes(response, MAX_RUNNER_JSON).await?)
                .unwrap_or_default();
        return Err(ApiError::new(
            if (400..600).contains(&status) {
                status
            } else {
                502
            },
            data["error"]
                .as_str()
                .unwrap_or("The local meeting runner could not complete this request."),
        ));
    }
    Ok(response)
}
/// Decode a successful runner response or report an invalid protocol payload.
async fn runner_json(
    method: Method,
    endpoint: &str,
    body: Option<Value>,
    timeout: u64,
) -> Result<Value, ApiError> {
    let response = runner_request(method, endpoint, body, timeout).await?;
    serde_json::from_slice(&bounded_runner_bytes(response, MAX_RUNNER_JSON).await?).map_err(|_| {
        ApiError::new(
            502,
            "The local runner returned an invalid response. Restart it and retry.",
        )
    })
}

/// Bound successful and failed runner payloads before allocation or JSON decoding.
async fn bounded_runner_bytes(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>, ApiError> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(ApiError::new(
            502,
            "The local runner returned an oversized response.",
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ApiError::new(502, "The local runner response was interrupted."))?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err(ApiError::new(
                502,
                "The local runner returned an oversized response.",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn calendar_email() -> Result<String, ApiError> {
    connected_email(read_tokens()?.as_ref())
}

fn connected_email(tokens: Option<&Tokens>) -> Result<String, ApiError> {
    tokens
        .and_then(|t| t.email.as_deref())
        .filter(|email| !email.is_empty() && email.len() <= 254 && email.contains('@'))
        .map(str::to_owned)
        .ok_or_else(|| {
            ApiError::new(
                401,
                "Connect Google Calendar before signing into the recording browser.",
            )
        })
}

fn auth_matches(auth: &Value, email: Option<&str>) -> bool {
    auth["state"] == "signed_in"
        && email.is_some_and(|email| {
            auth["email"]
                .as_str()
                .is_some_and(|actual| actual.eq_ignore_ascii_case(email))
        })
}

fn auth_view(auth: Value, email: Option<&str>) -> Value {
    let mut public = json!({"state": auth["state"], "accountMatches":auth_matches(&auth, email)});
    // Never forward profile paths, cookies, browser storage or unexpected fields.
    for key in ["email", "expectedEmail", "detail", "sessionId", "hostname"] {
        if let Some(value) = auth[key].as_str().filter(|value| value.len() <= 1024) {
            public[key] = json!(value);
        }
    }
    public
}

fn auth_session(raw: Option<&str>) -> Result<String, ApiError> {
    let raw =
        raw.ok_or_else(|| ApiError::bad("A valid recording browser session ID is required."))?;
    let parsed = Uuid::parse_str(raw)
        .map_err(|_| ApiError::bad("A valid recording browser session ID is required."))?;
    if parsed.to_string() != raw || parsed.get_version_num() != 4 {
        return Err(ApiError::bad(
            "A valid recording browser session ID is required.",
        ));
    }
    Ok(raw.to_owned())
}

fn verify_auth_session(auth: &Value, session: &str, email: &str) -> Result<(), ApiError> {
    if auth["state"] != "signing_in"
        || auth["sessionId"] != session
        || !auth["expectedEmail"]
            .as_str()
            .is_some_and(|expected| expected.eq_ignore_ascii_case(email))
    {
        return Err(ApiError::new(409, "The recording browser sign-in expired or belongs to a different Calendar account. Start again."));
    }
    Ok(())
}

fn verify_same_calendar(expected: &str) -> Result<(), ApiError> {
    if !calendar_email()?.eq_ignore_ascii_case(expected) {
        return Err(ApiError::new(
            409,
            "The connected Calendar account changed. Start recording browser sign-in again.",
        ));
    }
    Ok(())
}

// Authentication payloads may contain passwords. Never reflect upstream error text.
async fn auth_json(
    method: Method,
    endpoint: &str,
    body: Option<Value>,
    timeout: u64,
) -> Result<Value, ApiError> {
    runner_json(method, endpoint, body, timeout).await.map_err(|error| ApiError::new(error.status.as_u16(), "The recording browser could not complete this action. Refresh its status and retry."))
}

async fn cancel_interactive_auth() -> bool {
    let Ok(auth) = auth_json(Method::GET, "/auth", None, 2).await else {
        return false;
    };
    if auth["state"] != "signing_in" {
        return true;
    }
    let Ok(session) = auth_session(auth["sessionId"].as_str()) else {
        return false;
    };
    auth_json(
        Method::POST,
        "/auth/cancel",
        Some(json!({"sessionId":session})),
        35,
    )
    .await
    .is_ok()
}

async fn runner_auth_status() -> Result<Json<Value>, ApiError> {
    let email = read_tokens()?.and_then(|t| t.email);
    Ok(Json(auth_view(
        auth_json(Method::GET, "/auth", None, 5).await?,
        email.as_deref(),
    )))
}

async fn runner_auth_start(Json(body): Json<Value>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let _guard = RUNNER_AUTH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let email = calendar_email()?;
    let request = auth_start_request(&email, &body)?;
    let auth = auth_json(Method::POST, "/auth", Some(request), 20).await?;
    verify_same_calendar(&email)?;
    Ok((StatusCode::ACCEPTED, Json(auth_view(auth, Some(&email)))))
}

fn auth_start_request(email: &str, body: &Value) -> Result<Value, ApiError> {
    let mut request = json!({"email":email});
    if let Some(session) = body.get("sessionId") {
        request["sessionId"] = json!(auth_session(session.as_str())?);
    }
    Ok(request)
}

async fn runner_auth_finish(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let session = auth_session(body["sessionId"].as_str())?;
    let _guard = RUNNER_AUTH_LOCK
        .get_or_init(|| Mutex::new(()))
        .try_lock()
        .map_err(|_| {
            ApiError::new(
                409,
                "The recording browser is busy. Retry Finish sign-in shortly.",
            )
        })?;
    let email = calendar_email()?;
    let auth = auth_json(Method::GET, "/auth", None, 5).await?;
    verify_auth_session(&auth, &session, &email)?;
    let auth = auth_json(
        Method::POST,
        "/auth/finish",
        Some(json!({"sessionId":session})),
        48,
    )
    .await?;
    verify_same_calendar(&email)?;
    if !auth_matches(&auth, Some(&email)) {
        return Err(ApiError::new(
            409,
            "Sign into the recording browser using the connected Calendar account.",
        ));
    }
    Ok(Json(auth_view(auth, Some(&email))))
}

async fn runner_auth_cancel(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let session = auth_session(body["sessionId"].as_str())?;
    // Cancellation must fence an in-flight finish/start, rather than wait for it.
    let auth = auth_json(
        Method::POST,
        "/auth/cancel",
        Some(json!({"sessionId":session})),
        35,
    )
    .await?;
    let email = read_tokens().ok().flatten().and_then(|tokens| tokens.email);
    Ok(Json(auth_view(auth, email.as_deref())))
}

async fn runner_auth_delete() -> Result<Json<Value>, ApiError> {
    let _guard = RUNNER_AUTH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let auth = auth_json(Method::DELETE, "/auth", None, 20).await?;
    let email = read_tokens().ok().flatten().and_then(|tokens| tokens.email);
    Ok(Json(auth_view(auth, email.as_deref())))
}

async fn runner_auth_screen(
    Query(query): Query<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let session = auth_session(query.get("sessionId").map(String::as_str))?;
    let email = calendar_email()?;
    let auth = auth_json(Method::GET, "/auth", None, 5).await?;
    verify_auth_session(&auth, &session, &email)?;
    let response = runner_request(
        Method::GET,
        &format!("/auth/screen?sessionId={session}"),
        None,
        10,
    )
    .await
    .map_err(|error| {
        ApiError::new(
            error.status.as_u16(),
            "The recording browser screen is unavailable.",
        )
    })?;
    if response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("image/jpeg")
    {
        return Err(ApiError::new(
            502,
            "The recording browser returned an invalid screen.",
        ));
    }
    let bytes = bounded_runner_bytes(response, MAX_AUTH_SCREEN).await?;
    if !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err(ApiError::new(
            502,
            "The recording browser returned an invalid screen.",
        ));
    }
    verify_same_calendar(&email)?;
    let mut response = (
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response();
    if let Some(hostname) = auth["hostname"].as_str().filter(|hostname| {
        !hostname.is_empty()
            && hostname.len() <= 253
            && hostname
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    }) {
        if let Ok(value) = HeaderValue::from_str(hostname) {
            response.headers_mut().insert("x-runner-hostname", value);
        }
    }
    Ok(response)
}

fn auth_input(body: &Value) -> Result<Value, ApiError> {
    let session = auth_session(body["sessionId"].as_str())?;
    let kind = body["type"].as_str().unwrap_or_default();
    let mut value = json!({"sessionId":session,"type":kind});
    match kind {
        "click" => {
            let x = body["x"].as_u64().filter(|x| *x < 1280).ok_or_else(|| {
                ApiError::bad("Click coordinates are outside the recording browser.")
            })?;
            let y = body["y"].as_u64().filter(|y| *y < 900).ok_or_else(|| {
                ApiError::bad("Click coordinates are outside the recording browser.")
            })?;
            value["x"] = json!(x);
            value["y"] = json!(y);
        }
        "key" => {
            let key = body["key"]
                .as_str()
                .filter(|key| {
                    matches!(
                        *key,
                        "Enter"
                            | "Tab"
                            | "Shift+Tab"
                            | "Backspace"
                            | "Delete"
                            | "Escape"
                            | "ArrowLeft"
                            | "ArrowRight"
                            | "ArrowUp"
                            | "ArrowDown"
                            | "Home"
                            | "End"
                            | "PageUp"
                            | "PageDown"
                            | "Control+A"
                            | "Meta+A"
                    )
                })
                .ok_or_else(|| ApiError::bad("That recording browser key is not supported."))?;
            value["key"] = json!(key);
        }
        "text" => {
            let text = body["text"]
                .as_str()
                .filter(|text| {
                    !text.is_empty() && text.len() <= 4096 && !text.chars().any(char::is_control)
                })
                .ok_or_else(|| {
                    ApiError::bad("Enter at most 4096 bytes of text without control characters.")
                })?;
            value["text"] = json!(text);
        }
        "scroll" => {
            let delta = body["deltaY"]
                .as_i64()
                .filter(|delta| (-2000..=2000).contains(delta))
                .ok_or_else(|| {
                    ApiError::bad("The recording browser scroll distance is invalid.")
                })?;
            value["deltaY"] = json!(delta);
        }
        _ => {
            return Err(ApiError::bad(
                "That recording browser input is not supported.",
            ))
        }
    }
    Ok(value)
}

async fn runner_auth_input(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let input = auth_input(&body)?;
    let _guard = RUNNER_AUTH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let email = calendar_email()?;
    verify_auth_session(
        &auth_json(Method::GET, "/auth", None, 5).await?,
        input["sessionId"].as_str().unwrap(),
        &email,
    )?;
    let _ = auth_json(Method::POST, "/auth/input", Some(input), 10).await?;
    verify_same_calendar(&email)?;
    Ok(Json(json!({"ok":true})))
}
/// Report optional Google and runner setup without returning either integration's credentials.
async fn status() -> Result<Json<Value>, ApiError> {
    let tokens = read_tokens()?;
    let mut google = json!({"configured":google_configured(),"connected":tokens.is_some()});
    let email = tokens.and_then(|t| t.email);
    if let Some(email) = &email {
        google["email"] = json!(email);
    }
    let mut runner = json!({"configured":false,"reachable":false,"joinReady":false,"accountMatches":false,"auth":{"state":"signed_out","accountMatches":false},"detail":"Optional Google Meet runner needs local setup."});
    match runner_config() {
        Ok((_, token)) if !token.is_empty() => {
            runner["configured"] = json!(true);
            match runner_json(Method::GET, "/health", None, 2).await {
                Ok(health) => {
                    runner["reachable"] = json!(true);
                    runner["ready"] = health["ready"].clone();
                    runner["detail"] = health["detail"].clone();
                    match auth_json(Method::GET, "/auth", None, 2).await {
                        Ok(auth) => {
                            let matches = auth_matches(&auth, email.as_deref());
                            runner["auth"] = auth_view(auth, email.as_deref());
                            runner["accountMatches"] = json!(matches);
                            runner["joinReady"] = json!(health["ready"] == true && matches);
                        }
                        Err(_) => {
                            runner["auth"] = json!({"state":"error","accountMatches":false,"detail":"The recording browser status is unavailable."})
                        }
                    }
                }
                Err(error) => runner["detail"] = json!(error.message),
            }
        }
        Err(error) => runner["detail"] = json!(error.message),
        _ => (),
    }
    Ok(Json(json!({"google":google,"runner":runner})))
}
/// Persist a unique start reservation before joining and compensate any ambiguous acceptance.
async fn bot_start(Json(body): Json<Value>) -> Result<(StatusCode, Json<Value>), ApiError> {
    let _guard = BOT_START_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let id = validate_id(body["meetingId"].as_str())?;
    if body["consent"] != true {
        return Err(ApiError::new(
            422,
            "Confirm participant consent before inviting the recording bot.",
        ));
    }
    let url = validate_meet_url(body["url"].as_str().unwrap_or_default())?;
    if store::get_meeting(id)?.is_none() {
        return Err(ApiError::not_found());
    }
    let _auth_guard = RUNNER_AUTH_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let email = calendar_email()?;
    let auth = auth_json(Method::GET, "/auth", None, 5).await?;
    if !auth_matches(&auth, Some(&email)) {
        return Err(ApiError::new(409, "Sign into the recording browser using the connected Calendar account before inviting it."));
    }
    let pending = start_file(id);
    if pending.exists() {
        cancel_start(id, &pending).await?;
    }
    let request_id = Uuid::new_v4().to_string();
    crate::config::write_private(
        &pending,
        &serde_json::to_vec(&json!({"meetingId":id,"requestId":request_id}))?,
    )?;
    // Reserve first so deletion cannot race acceptance; no database write follows joining.
    if let Err(error) = store::update_meeting(id, json!({"meetingUrl":url,"consent":true})) {
        fs::remove_file(&pending)?;
        return Err(error);
    }
    let result = runner_json(
        Method::POST,
        "/sessions",
        Some(json!({"meetingId":id,"requestId":request_id,"url":url,"consent":true,"expectedEmail":email})),
        10,
    )
    .await;
    let session = match result {
        Ok(session) if session["meetingId"] == id && session["requestId"] == request_id => {
            match fs::remove_file(&pending) {
                Ok(()) => session,
                Err(error) => {
                    cancel_start(id, &pending).await?;
                    return Err(error.into());
                }
            }
        }
        other => {
            cancel_start(id, &pending).await?;
            return Err(other.err().unwrap_or_else(|| ApiError::new(502, "The runner returned an unrecognized start ID. That recording attempt was cancelled.")));
        }
    };
    Ok((StatusCode::ACCEPTED, Json(session)))
}

/// Durable start reservations also protect meetings from deletion during ambiguity.
fn start_file(id: &str) -> PathBuf {
    store::data_dir()
        .join("bot-starts")
        .join(format!("{id}.json"))
}

/// Cancellation is scoped to a start ID and fences off a delayed POST in the runner.
async fn cancel_start(id: &str, pending: &std::path::Path) -> Result<(), ApiError> {
    let state: Value = serde_json::from_slice(&fs::read(pending)?)?;
    let request_id = validate_id(state["requestId"].as_str())?;
    let result = runner_json(
        Method::DELETE,
        &format!("/sessions/{id}?requestId={request_id}"),
        None,
        10,
    )
    .await;
    if !result.as_ref().is_ok_and(|state| {
        state["meetingId"] == id
            && state["requestId"] == request_id
            && matches!(
                state["status"].as_str(),
                Some("stopping" | "completed" | "failed")
            )
    }) {
        return Err(ApiError::new(503, "The recording start could not be confirmed or cancelled. It may still be active. Keep the runner available and use Stop bot; Echo will keep retrying cancellation."));
    }
    fs::remove_file(pending)?;
    Ok(())
}

/// Recover interrupted starts before serving, then retry while an offline runner returns.
pub async fn recover_bot_starts() {
    reconcile_starts().await;
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            reconcile_starts().await;
        }
    });
}

/// Serialize reconciliation with starts so an in-flight accepted attempt is not cancelled.
async fn reconcile_starts() {
    let _guard = BOT_START_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let Ok(files) = fs::read_dir(store::data_dir().join("bot-starts")) else {
        return;
    };
    for file in files.flatten() {
        let path = file.path();
        let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        if path.extension().is_some_and(|v| v == "json") && validate_id(Some(id)).is_ok() {
            if let Err(error) = cancel_start(id, &path).await {
                tracing::warn!("Pending recording cancellation: {}", error.message);
            }
        }
    }
}
/// Reconcile runner recording and completion states with the meeting lifecycle.
async fn bot_status(Query(query): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let id = validate_id(query.get("meetingId").map(String::as_str))?;
    let session = runner_json(Method::GET, &format!("/sessions/{id}"), None, 10).await?;
    if let Some(meeting) = store::get_meeting(id)? {
        if session["status"] == "recording" && meeting["status"] != "recording" {
            store::update_meeting(id, json!({"status":"recording","error":Value::Null}))?;
        } else if matches!(session["status"].as_str(), Some("completed" | "failed"))
            && matches!(meeting["status"].as_str(), Some("recording" | "paused"))
        {
            store::update_meeting(
                id,
                json!({"status":if session["audioAvailable"]==true{"saved"}else{"error"},"error":if session["status"]=="failed"{session["detail"].clone()}else{Value::Null}}),
            )?;
        }
    }
    Ok(Json(session))
}
/// Cancel unresolved start intent or request the active guest to leave its meeting.
async fn bot_stop(Query(query): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let id = validate_id(query.get("meetingId").map(String::as_str))?;
    let guard = BOT_START_LOCK.get_or_init(|| Mutex::new(())).lock().await;
    let pending = start_file(id);
    if pending.exists() {
        cancel_start(id, &pending).await?;
        return Ok(Json(
            json!({"meetingId":id,"status":"stopping","detail":"The uncertain start was cancelled. Waiting for the runner to finish."}),
        ));
    }
    drop(guard);
    Ok(Json(
        runner_json(Method::DELETE, &format!("/sessions/{id}"), None, 10).await?,
    ))
}
/// Retrieve a bounded WAV from the runner without losing the original on transfer failure.
async fn audio_bytes(id: &str) -> Result<Vec<u8>, ApiError> {
    let mut response =
        runner_request(Method::GET, &format!("/sessions/{id}/audio"), None, 60).await?;
    let too_large = || {
        ApiError::new(413,"This recording exceeds the 512 MB import limit. Copy its WAV from the local runner data folder.")
    };
    if response.content_length().unwrap_or(0) > MAX_AUDIO as u64 {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|ApiError::new(502,"Audio transfer from the local runner was interrupted. Retry; the original remains on disk."))? {
        if bytes.len()+chunk.len()>MAX_AUDIO {return Err(too_large());} bytes.extend_from_slice(&chunk);
    }
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(ApiError::new(
            422,
            "The runner did not return a supported WAV recording.",
        ));
    }
    Ok(bytes)
}
/// Download finalized runner audio as a local attachment.
async fn bot_audio(Query(query): Query<HashMap<String, String>>) -> Result<Response, ApiError> {
    let id = validate_id(query.get("meetingId").map(String::as_str))?;
    let bytes = audio_bytes(id).await?;
    Ok((
        [
            (header::CONTENT_TYPE, "audio/wav"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"meeting-audio.wav\"",
            ),
        ],
        bytes,
    )
        .into_response())
}
/// Split runner audio into deterministic store-sized chunks for resumable import.
fn persist_bot_audio(
    bytes: &[u8],
    mut persist: impl FnMut(&[u8], i64) -> Result<(), ApiError>,
) -> Result<(), ApiError> {
    for (sequence, chunk) in bytes.chunks(BOT_IMPORT_CHUNK_BYTES).enumerate() {
        persist(chunk, sequence as i64)?;
    }
    Ok(())
}

/// Import finalized runner audio idempotently while retaining existing processed results on retries.
async fn bot_import(Query(query): Query<HashMap<String, String>>) -> Result<Json<Value>, ApiError> {
    let id = validate_id(query.get("meetingId").map(String::as_str))?;
    let meeting = store::get_meeting(id)?.ok_or_else(ApiError::not_found)?;
    let session = runner_json(Method::GET, &format!("/sessions/{id}"), None, 10).await?;
    if session["audioAvailable"] != true
        || !matches!(session["status"].as_str(), Some("completed" | "failed"))
    {
        return Err(ApiError::new(
            409,
            "Stop the bot and wait for its recording to finish before importing.",
        ));
    }
    let bytes = audio_bytes(id).await?;
    let previously_complete = meeting["tracks"].as_array().is_some_and(|tracks| {
        tracks.iter().any(|track| {
            track["id"] == "meeting-bot" && track["bytes"].as_u64() == Some(bytes.len() as u64)
        })
    });
    if !previously_complete {
        store::update_meeting(id, json!({"status":"processing","error":Value::Null}))?;
    }
    // Replay all deterministic chunks on retry. The store accepts identical
    // sequence/hash pairs, so an interrupted import cannot look complete just
    // because its first chunk already created the track.
    let result = persist_bot_audio(&bytes, |chunk, sequence| {
        store::add_audio(
            id,
            chunk,
            Some("meeting-bot"),
            "Google Meet audio",
            "audio/wav",
            Some(sequence),
        )?;
        Ok(())
    });
    if let Err(error) = result {
        let _ = store::update_meeting(
            id,
            json!({"status":"error","error":format!("Audio import stopped: {} Retry importing to resume saved chunks.",error.message)}),
        );
        return Err(error);
    }
    if previously_complete && matches!(meeting["status"].as_str(), Some("ready" | "processing")) {
        return Ok(Json(
            json!({"meeting":store::get_meeting(id)?.ok_or_else(ApiError::not_found)?,"imported":true}),
        ));
    }
    let updated = store::update_meeting(
        id,
        json!({"status":"saved","duration":session["duration"].as_f64().unwrap_or(meeting["duration"].as_f64().unwrap_or(0.0)),"error":if session["status"]=="failed"{session["detail"].clone()}else{Value::Null}}),
    )?;
    Ok(Json(json!({"meeting":updated,"imported":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    const TEST_EMAIL: &str = "sublimeinnovationtechnologies@gmail.com";
    #[test]
    fn runner_login_uses_calendar_identity_and_fences_sessions() {
        let session = Uuid::new_v4().to_string();
        let request = auth_start_request(TEST_EMAIL, &json!({"email":"attacker@example.com","expectedEmail":"attacker@example.com","sessionId":session,"password":"do-not-forward"})).unwrap();
        assert_eq!(request, json!({"email":TEST_EMAIL,"sessionId":session}));
        assert!(auth_start_request(TEST_EMAIL, &json!({"sessionId":"../credentials"})).is_err());
        assert!(auth_session(Some("00000000-0000-0000-0000-000000000000")).is_err());
        let active = json!({"state":"signing_in","sessionId":session,"expectedEmail":TEST_EMAIL});
        assert!(verify_auth_session(&active, &session, TEST_EMAIL).is_ok());
        assert!(verify_auth_session(&active, &Uuid::new_v4().to_string(), TEST_EMAIL).is_err());
        assert!(verify_auth_session(&active, &session, "other@example.com").is_err());
        assert!(verify_auth_session(
            &json!({"state":"expired","sessionId":session,"expectedEmail":TEST_EMAIL}),
            &session,
            TEST_EMAIL
        )
        .is_err());
        assert!(connected_email(None).is_err());
        let signed_in = json!({"state":"signed_in","email":TEST_EMAIL});
        assert!(!auth_matches(&signed_in, None));
        assert!(!auth_matches(&signed_in, Some("other@example.com")));
        assert!(auth_matches(&signed_in, Some(TEST_EMAIL)));
    }

    #[test]
    fn runner_auth_public_status_and_input_do_not_forward_private_fields() {
        let public = auth_view(
            json!({"state":"signed_in","email":TEST_EMAIL,"cookie":"secret","profilePath":"/credentials/private","storageState":{"token":"secret"}}),
            Some(TEST_EMAIL),
        );
        assert_eq!(
            public,
            json!({"state":"signed_in","email":TEST_EMAIL,"accountMatches":true})
        );
        let session = Uuid::new_v4().to_string();
        let text = auth_input(&json!({"sessionId":session,"type":"text","text":"manual secret input","email":"attacker@example.com","url":"file:///etc/passwd"})).unwrap();
        assert_eq!(
            text,
            json!({"sessionId":session,"type":"text","text":"manual secret input"})
        );
        for bad in [
            json!({"type":"click","x":1280,"y":0}),
            json!({"type":"click","x":0,"y":900}),
            json!({"type":"click","x":-1,"y":0}),
            json!({"type":"key","key":"F12"}),
            json!({"type":"text","text":"secret\nEnter"}),
            json!({"type":"text","text":"a".repeat(4097)}),
            json!({"type":"scroll","deltaY":2001}),
            json!({"type":"evaluate","text":"fetch('/cookies')"}),
        ] {
            let mut bad = bad;
            bad["sessionId"] = json!(session);
            assert!(auth_input(&bad).is_err());
        }
        assert!(auth_input(&json!({"sessionId":session,"type":"key","key":"Shift+Tab"})).is_ok());
    }

    async fn mock_response(raw: Vec<u8>) -> reqwest::Response {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                assert!(request.len() < 4096);
                request.push(socket.read_u8().await.unwrap());
            }
            let _ = socket.write_all(&raw).await;
        });
        Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(format!("http://{address}"))
            .send()
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn runner_proxy_bounds_declared_and_chunked_responses() {
        let response = mock_response(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_AUTH_SCREEN + 1
            )
            .into_bytes(),
        )
        .await;
        assert_eq!(
            bounded_runner_bytes(response, MAX_AUTH_SCREEN)
                .await
                .unwrap_err()
                .status,
            StatusCode::BAD_GATEWAY
        );
        let response = mock_response(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\nabcd\r\n4\r\nefgh\r\n0\r\n\r\n".to_vec()).await;
        assert!(bounded_runner_bytes(response, 7).await.is_err());
        let response = mock_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\n\xff\xd8\xff\xd9"
                .to_vec(),
        )
        .await;
        assert_eq!(
            bounded_runner_bytes(response, MAX_AUTH_SCREEN)
                .await
                .unwrap(),
            [0xff, 0xd8, 0xff, 0xd9]
        );
    }
    #[test]
    fn state_requires_matching_fresh_cookie() {
        let value = OAuthState {
            state: "secret-state".into(),
            verifier: "pkce".into(),
            created_at: Utc::now().timestamp_millis(),
        };
        let cookie = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap());
        assert_eq!(
            validate_state(Some(&cookie), Some("secret-state")).unwrap(),
            "pkce"
        );
        assert!(validate_state(Some(&cookie), Some("forged-state")).is_err());
        assert!(validate_state(None, None).is_err());
        let expired = OAuthState {
            created_at: Utc::now().timestamp_millis() - 700_000,
            ..value
        };
        assert!(validate_state(
            Some(&URL_SAFE_NO_PAD.encode(serde_json::to_vec(&expired).unwrap())),
            Some("secret-state")
        )
        .is_err());
    }
    #[test]
    fn destinations_cannot_escape_loopback_or_meet() {
        for bad in [
            "http://169.254.169.254",
            "https://localhost.attacker.test",
            "http://user:pass@localhost",
            "file:///etc/passwd",
        ] {
            assert!(loopback_url(bad).is_err(), "{bad}");
        }
        assert!(loopback_url("http://127.0.0.1:8765").is_ok());
        for bad in [
            "http://127.0.0.1:22",
            "https://meet.google.com.evil.test/abc-defg-hij",
            "https://user@meet.google.com/abc-defg-hij",
            "https://meet.google.com:444/abc-defg-hij",
            "https://zoom.us/j/123",
            "https://meet.google.com/lookup/private",
        ] {
            assert!(validate_meet_url(bad).is_err(), "{bad}");
        }
        assert_eq!(
            validate_meet_url("https://meet.google.com/abc-defg-hij?authuser=0").unwrap(),
            "https://meet.google.com/abc-defg-hij"
        );
        assert!(validate_id(Some("../../credentials")).is_err());
        assert!(validate_id(Some("")).is_err());
        assert!(validate_id(Some("meeting-1")).is_ok());
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
    #[test]
    fn large_bot_audio_resumes_partial_import_without_duplicates() {
        // A >128 MB WAV exceeds the store's single-upload limit. Chunk replay
        // must finish it safely after a simulated interruption at sequence 1.
        let mut bytes = vec![0u8; 128 * 1024 * 1024 + 137];
        bytes[0..4].copy_from_slice(b"RIFF");
        bytes[8..12].copy_from_slice(b"WAVE");
        bytes[BOT_IMPORT_CHUNK_BYTES] = 7;
        bytes[2 * BOT_IMPORT_CHUNK_BYTES] = 11;
        let mut saved = HashMap::<i64, (usize, Vec<u8>)>::new();
        let persist = |chunk: &[u8], seq: i64, saved: &mut HashMap<i64, (usize, Vec<u8>)>| {
            assert!(chunk.len() <= BOT_IMPORT_CHUNK_BYTES);
            let entry = (chunk.len(), Sha256::digest(chunk).to_vec());
            if let Some(existing) = saved.get(&seq) {
                assert_eq!(existing, &entry);
            } else {
                saved.insert(seq, entry);
            }
        };
        let interrupted = persist_bot_audio(&bytes, |chunk, seq| {
            if seq == 1 {
                return Err(ApiError::new(507, "Simulated full disk"));
            }
            persist(chunk, seq, &mut saved);
            Ok(())
        });
        assert!(interrupted.is_err());
        assert_eq!(saved.len(), 1);
        persist_bot_audio(&bytes, |chunk, seq| {
            persist(chunk, seq, &mut saved);
            Ok(())
        })
        .unwrap();
        assert_eq!(saved.len(), 3);
        assert_eq!(
            saved.values().map(|(size, _)| size).sum::<usize>(),
            bytes.len()
        );
        persist_bot_audio(&bytes, |chunk, seq| {
            persist(chunk, seq, &mut saved);
            Ok(())
        })
        .unwrap();
        assert_eq!(saved.len(), 3);
    }
    #[tokio::test]
    async fn callback_without_valid_state_clears_cookie_and_returns_an_error() {
        let response = callback(
            HeaderMap::new(),
            Query(HashMap::from([("code".into(), "untrusted".into())])),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert!(response.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("calendar=error"));
        assert!(response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
    }
    #[tokio::test]
    async fn bot_cannot_join_without_explicit_consent() {
        let result=bot_start(Json(json!({"meetingId":"example","url":"https://meet.google.com/abc-defg-hij","consent":false}))).await;
        assert_eq!(result.unwrap_err().status, StatusCode::UNPROCESSABLE_ENTITY);
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
