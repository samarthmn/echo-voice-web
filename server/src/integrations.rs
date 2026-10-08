//! Optional read-only Google Calendar integration.
//! Credentials and recordings remain on this machine; Calendar and the live
//! meeting itself necessarily communicate with Google.
use crate::{security::ApiError, store};
use axum::{
    extract::Query,
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{Duration as ChronoDuration, Utc};
use reqwest::Client;
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
    let current_account = read_tokens().ok()??.email?;
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
        .route(
            "/integrations/google/disconnect",
            post(disconnect).delete(disconnect),
        )
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
    let mut google = json!({"configured":google_configured(),"connected":tokens.is_some()});
    if let Some(email) = tokens.and_then(|t| t.email) {
        google["email"] = json!(email);
    }
    Ok(Json(json!({"google":google})))
}
#[cfg(test)]
mod tests {
    use super::*;
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
