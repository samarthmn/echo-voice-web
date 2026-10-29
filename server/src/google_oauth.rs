//! Environment-configured Web OAuth with PKCE and a one-use browser session.
//! The configured same-origin callback is served by the existing web server.
use crate::security::ApiError;
use axum::{
    extract::Query,
    http::{header, HeaderMap, HeaderValue},
    response::{IntoResponse, Redirect, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use url::Url;
use zeroize::Zeroizing;

pub(super) const SCOPE: &str = "openid email https://www.googleapis.com/auth/calendar.readonly";
const COOKIE: &str = "echo_google_oauth";
const LIFETIME: Duration = Duration::from_secs(600);
static SESSION: OnceLock<Mutex<Option<Arc<Session>>>> = OnceLock::new();

pub(super) struct Config {
    pub id: String,
    pub secret: Option<Zeroizing<String>>,
    pub redirect: String,
    #[cfg(test)]
    pub endpoints: Option<(String, String)>,
}
impl Config {
    pub fn token_url(&self) -> &str {
        #[cfg(test)]
        if let Some((token, _)) = &self.endpoints {
            return token;
        }
        "https://oauth2.googleapis.com/token"
    }
    pub fn profile_url(&self) -> &str {
        #[cfg(test)]
        if let Some((_, profile)) = &self.endpoints {
            return profile;
        }
        "https://openidconnect.googleapis.com/v1/userinfo"
    }
}
pub(super) fn config() -> Result<Config, ApiError> {
    let id = std::env::var("GOOGLE_CLIENT_ID").unwrap_or_default();
    let secret = std::env::var("GOOGLE_CLIENT_SECRET").unwrap_or_default();
    if id.is_empty() || secret.is_empty() || id.len() > 256 || secret.len() > 4096 {
        return Err(ApiError::new(503, "Google Calendar is not configured for this source build. See the maintainer setup in docs/integrations.md."));
    }
    let redirect = crate::config::redirect_uri();
    super::loopback_url(&redirect)?;
    Ok(Config {
        id,
        secret: Some(Zeroizing::new(secret)),
        redirect,
        #[cfg(test)]
        endpoints: None,
    })
}
fn random_secret() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0; 32]);
    OsRng.fill_bytes(bytes.as_mut());
    Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()))
}
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.as_bytes()
            .iter()
            .zip(b.as_bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}
pub(super) fn cookie_value(headers: &HeaderMap) -> Option<&str> {
    let mut values = headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == COOKIE).then_some(value)
        });
    let value = values.next()?;
    (values.next().is_none() && value.len() <= 128).then_some(value)
}
fn state_error() -> ApiError {
    ApiError::bad(
        "Calendar security check failed, was cancelled, or expired. Connect your calendar again.",
    )
}
struct Session {
    config: Config,
    state: Zeroizing<String>,
    browser: Zeroizing<String>,
    verifier: Zeroizing<String>,
    origin: String,
    expires: Instant,
    stop: watch::Sender<bool>,
    claimed: std::sync::atomic::AtomicBool,
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}
fn sessions() -> &'static Mutex<Option<Arc<Session>>> {
    SESSION.get_or_init(|| Mutex::new(None))
}
fn clear_matching(session: &Arc<Session>) {
    if let Ok(mut current) = sessions().lock() {
        if current
            .as_ref()
            .is_some_and(|value| Arc::ptr_eq(value, session))
        {
            *current = None;
        }
    }
    let _ = session.stop.send(true);
}
pub(super) fn cancel() -> bool {
    let previous = sessions()
        .lock()
        .ok()
        .and_then(|mut current| current.take());
    if let Some(previous) = previous {
        let _ = previous.stop.send(true);
        true
    } else {
        false
    }
}
pub(super) fn pending() -> bool {
    sessions().lock().is_ok_and(|current| {
        current
            .as_ref()
            .is_some_and(|session| session.expires > Instant::now())
    })
}
fn authorization_url(session: &Session) -> Result<String, ApiError> {
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(session.verifier.as_bytes()));
    let mut url = Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|_| ApiError::new(500, "Google authorization is unavailable."))?;
    url.query_pairs_mut().extend_pairs([
        ("client_id", session.config.id.as_str()),
        ("redirect_uri", session.config.redirect.as_str()),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("access_type", "offline"),
        ("prompt", "select_account consent"),
        ("state", session.state.as_str()),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge.as_str()),
    ]);
    Ok(url.into())
}
fn authorization_redirect(session: &Session) -> Result<Response, ApiError> {
    let mut response = Redirect::to(&authorization_url(session)?).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "echo_google_oauth=; Path=/api/integrations/google; HttpOnly; SameSite=Lax; Max-Age=0",
        ),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600{}",
            session.browser.as_str(),
            if session.config.redirect.starts_with("https:") {
                "; Secure"
            } else {
                ""
            }
        ))
        .map_err(|_| state_error())?,
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    Ok(response)
}
fn clear_cookie(response: &mut Response) {
    for value in [
        "echo_google_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
        "echo_google_oauth=; Path=/api/integrations/google; HttpOnly; SameSite=Lax; Max-Age=0",
    ] {
        response
            .headers_mut()
            .append(header::SET_COOKIE, HeaderValue::from_static(value));
    }
}
fn outcome(origin: &str, result: Result<(), ApiError>) -> Response {
    let query = match result {
        Ok(()) => "calendar=connected".into(),
        Err(error) => url::form_urlencoded::Serializer::new(String::new())
            .append_pair("calendar", "error")
            .append_pair("message", &error.message)
            .finish(),
    };
    let mut response = Redirect::to(&format!("{origin}/?{query}")).into_response();
    clear_cookie(&mut response);
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    response
}
async fn begin(config: Config, origin: String, lifetime: Duration) -> Result<Response, ApiError> {
    let (stop, mut stopped) = watch::channel(false);
    let session = Arc::new(Session {
        config,
        state: random_secret(),
        browser: random_secret(),
        verifier: random_secret(),
        origin,
        expires: Instant::now() + lifetime,
        stop,
        claimed: std::sync::atomic::AtomicBool::new(false),
    });
    let response = authorization_redirect(&session)?;
    {
        let mut current = sessions().lock().map_err(|_| state_error())?;
        if let Some(previous) = current.replace(session.clone()) {
            let _ = previous.stop.send(true);
        }
    }
    tokio::spawn(async move {
        tokio::select! { _ = tokio::time::sleep(lifetime) => {}, _ = stopped.changed() => {} }
        clear_matching(&session);
    });
    Ok(response)
}
pub(super) async fn connect(headers: HeaderMap) -> Result<Response, ApiError> {
    let config = config()?;
    let origin = super::loopback_url(&config.redirect)?
        .origin()
        .ascii_serialization();
    let expected_host = origin
        .split_once("://")
        .map(|(_, host)| host)
        .unwrap_or_default();
    if headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(expected_host) {
        return Ok(
            Redirect::to(&format!("{origin}/api/integrations/google/connect")).into_response(),
        );
    }
    begin(config, origin, LIFETIME).await
}
async fn complete(
    session: Arc<Session>,
    headers: HeaderMap,
    query: HashMap<String, String>,
) -> Response {
    use std::sync::atomic::Ordering;
    let matches = cookie_value(&headers).is_some_and(|value| same_secret(value, &session.browser))
        && query
            .get("state")
            .is_some_and(|value| same_secret(value, &session.state));
    let current = sessions().lock().is_ok_and(|current| {
        current
            .as_ref()
            .is_some_and(|value| Arc::ptr_eq(value, &session))
    });
    if !matches
        || !current
        || session.expires <= Instant::now()
        || session
            .claimed
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
    {
        return state_error().into_response();
    }
    let result = async {
        if query.contains_key("error") {
            return Err(ApiError::bad(
                "Calendar access was declined. Your previous connection has not been changed.",
            ));
        }
        let code = query
            .get("code")
            .filter(|value| !value.is_empty() && value.len() <= 4096)
            .ok_or_else(state_error)?;
        let tokens =
            super::exchange_authorization(&session.config, code, &session.verifier).await?;
        let _tokens = super::TOKEN_LOCK
            .get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await;
        // Keep the session lock through the save so cancellation cannot race publication.
        let committing = session.clone();
        crate::store::blocking(move || {
            let mut current = sessions().lock().map_err(|_| state_error())?;
            if committing.expires <= Instant::now()
                || !current
                    .as_ref()
                    .is_some_and(|value| Arc::ptr_eq(value, &committing))
            {
                return Err(state_error());
            }
            super::save_tokens(&tokens)?;
            *current = None;
            Ok(())
        })
        .await?;
        Ok(())
    }
    .await;
    clear_matching(&session);
    outcome(&session.origin, result)
}
pub(super) async fn callback(
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let session = sessions().lock().ok().and_then(|current| current.clone());
    if let Some(session) = session {
        complete(session, headers, query).await
    } else {
        outcome("", Err(state_error()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{integrations, store};
    use axum::{
        extract::Form,
        http::StatusCode,
        routing::{get, post},
        Json, Router,
    };
    use serde_json::json;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const CLIENT: &str = "123_echo-test.apps.googleusercontent.com";
    struct Provider {
        url: String,
        forms: Arc<Mutex<Vec<HashMap<String, String>>>>,
        challenge: Arc<Mutex<String>>,
        mode: Arc<AtomicUsize>,
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Provider {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Provider {
        async fn start() -> Self {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let forms = Arc::new(Mutex::new(Vec::new()));
            let challenge = Arc::new(Mutex::new(String::new()));
            let mode = Arc::new(AtomicUsize::new(0));
            let entered = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let (records, expected, behavior, began, resume) = (
                forms.clone(),
                challenge.clone(),
                mode.clone(),
                entered.clone(),
                release.clone(),
            );
            let router = Router::new().route("/token",post(move |Form(form):Form<HashMap<String,String>>| {
                let (records, expected, behavior, began, resume) = (records.clone(),expected.clone(),behavior.clone(),began.clone(),resume.clone());
                async move {
                    records.lock().unwrap().push(form.clone());
                    if form.get("grant_type").map(String::as_str) == Some("authorization_code") {
                        let actual = URL_SAFE_NO_PAD.encode(Sha256::digest(form.get("code_verifier").unwrap().as_bytes()));
                        if actual != *expected.lock().unwrap() || form.get("code").map(String::as_str) != Some("synthetic-code") {
                            return (StatusCode::BAD_REQUEST,Json(json!({"error":"invalid_grant"}))).into_response();
                        }
                    }
                    if behavior.load(Ordering::SeqCst) == 2 { began.notify_one(); resume.notified().await; }
                    if behavior.load(Ordering::SeqCst) == 1 {
                        return (StatusCode::UNAUTHORIZED,Json(json!({"error":"invalid_grant"}))).into_response();
                    }
                    if behavior.load(Ordering::SeqCst) == 3 { return "x".repeat(1024*1024+1).into_response(); }
                    if behavior.load(Ordering::SeqCst) == 4 {
                        return (StatusCode::BAD_REQUEST,Json(json!({"error":"invalid_client","error_description":"synthetic-private-diagnostic"}))).into_response();
                    }
                    Json(json!({"access_token":"synthetic-new-access","refresh_token":"synthetic-new-refresh","expires_in":3600,"scope":SCOPE})).into_response()
                }
            })).route("/profile",get(|headers:HeaderMap|async move {
                assert_eq!(headers[header::AUTHORIZATION],"Bearer synthetic-new-access");
                Json(json!({"email":"synthetic@example.test"}))
            }));
            let task = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                url,
                forms,
                challenge,
                mode,
                entered,
                release,
                task,
            }
        }
        fn config(&self) -> Config {
            Config {
                id: CLIENT.into(),
                secret: Some(Zeroizing::new("synthetic-web-secret".into())),
                redirect: "http://localhost:3000/api/integrations/google/callback".into(),
                endpoints: Some((
                    format!("{}/token", self.url),
                    format!("{}/profile", self.url),
                )),
            }
        }
    }
    fn fixture() -> tempfile::TempDir {
        cancel();
        store::reset_for_tests();
        let directory = store::test_directory();
        std::env::set_var("ECHO_DATA_DIR", directory.path());
        store::test_key();
        store::init().unwrap();
        directory
    }
    fn previous() -> Vec<u8> {
        integrations::save_tokens(&integrations::Tokens {
            access_token: "synthetic-prior-access".into(),
            refresh_token: Some("synthetic-prior-refresh".into()),
            expires_at: chrono::Utc::now().timestamp_millis() + 3_600_000,
            email: Some("previous@example.test".into()),
            client_id: Some(CLIENT.into()),
            reconnect_required: false,
        })
        .unwrap();
        fs::read(integrations::credentials_file().unwrap()).unwrap()
    }
    async fn launch(provider: &Provider, lifetime: Duration) -> Arc<Session> {
        let response = begin(provider.config(), "http://localhost:3000".into(), lifetime)
            .await
            .unwrap();
        let auth = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        assert_eq!(auth.host_str(), Some("accounts.google.com"));
        let fields: HashMap<_, _> = auth.query_pairs().into_owned().collect();
        assert_eq!(fields["scope"], SCOPE);
        assert_eq!(fields["client_id"], CLIENT);
        assert_eq!(
            fields["redirect_uri"],
            "http://localhost:3000/api/integrations/google/callback"
        );
        assert_eq!(fields["code_challenge_method"], "S256");
        assert!(!fields.contains_key("client_secret"));
        assert!(!fields.contains_key("code_verifier"));
        *provider.challenge.lock().unwrap() = fields["code_challenge"].clone();
        let session = sessions().lock().unwrap().as_ref().unwrap().clone();
        let cookies = response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert!(cookies
            .iter()
            .any(|value| value.contains(session.browser.as_str())));
        assert!(cookies
            .iter()
            .all(|value| !value.contains(session.verifier.as_str())
                && !value.contains("synthetic-web-secret")));
        session
    }
    async fn response(
        session: Arc<Session>,
        state: &str,
        cookie: &str,
        result: (&str, &str),
    ) -> Response {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, HeaderValue::from_str(cookie).unwrap());
        complete(
            session,
            headers,
            HashMap::from([
                ("state".into(), state.into()),
                (result.0.into(), result.1.into()),
            ]),
        )
        .await
    }
    fn browser(session: &Session) -> String {
        format!("{COOKIE}={}", session.browser.as_str())
    }
    #[tokio::test]
    async fn web_pkce_binds_browser_consumes_once_and_preserves_previous_connection() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let _directory = fixture();
        let original = previous();
        let provider = Provider::start().await;
        let session = launch(&provider, Duration::from_secs(10)).await;
        for (state, cookie) in [
            ("wrong".into(), browser(&session)),
            (session.state.to_string(), "echo_google_oauth=wrong".into()),
            (
                session.state.to_string(),
                format!("{}; {}", browser(&session), browser(&session)),
            ),
        ] {
            let result =
                response(session.clone(), &state, &cookie, ("code", "synthetic-code")).await;
            assert_eq!(result.status(), StatusCode::BAD_REQUEST);
            assert!(pending());
        }
        let denied = response(
            session.clone(),
            &session.state,
            &browser(&session),
            ("error", "access_denied"),
        )
        .await;
        assert!(denied.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("calendar=error"));
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            original
        );
        assert!(provider.forms.lock().unwrap().is_empty());
        assert!(!pending());
        let session = launch(&provider, Duration::from_secs(10)).await;
        *provider.challenge.lock().unwrap() = "wrong-pkce-challenge".into();
        let denied = response(
            session.clone(),
            &session.state,
            &browser(&session),
            ("code", "synthetic-code"),
        )
        .await;
        assert!(denied.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("calendar=error"));
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            original
        );
        provider.forms.lock().unwrap().clear();
        let session = launch(&provider, Duration::from_secs(10)).await;
        let success = response(
            session.clone(),
            &session.state,
            &browser(&session),
            ("code", "synthetic-code"),
        )
        .await;
        assert_eq!(
            success.headers()[header::LOCATION],
            "http://localhost:3000/?calendar=connected"
        );
        let saved = integrations::read_tokens().unwrap().unwrap();
        assert_eq!(saved.client_id.as_deref(), Some(CLIENT));
        let disk = fs::read(integrations::credentials_file().unwrap()).unwrap();
        assert!(disk.starts_with(b"ECHOENC1"));
        assert!(!String::from_utf8_lossy(&disk).contains("synthetic-new"));
        assert_eq!(provider.forms.lock().unwrap().len(), 1);
        assert_eq!(
            response(
                session.clone(),
                &session.state,
                &browser(&session),
                ("code", "synthetic-code")
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        let session = launch(&provider, Duration::from_secs(10)).await;
        assert!(cancel());
        assert_eq!(
            response(
                session.clone(),
                &session.state,
                &browser(&session),
                ("code", "synthetic-code")
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        let session = launch(&provider, Duration::from_millis(20)).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!pending());
        assert_eq!(
            response(
                session.clone(),
                &session.state,
                &browser(&session),
                ("code", "synthetic-code")
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            disk
        );
        store::reset_for_tests();
    }
    #[tokio::test]
    async fn cancellation_during_web_token_exchange_never_replaces_previous_credentials() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let _directory = fixture();
        let original = previous();
        let provider = Provider::start().await;
        provider.mode.store(2, Ordering::SeqCst);
        let session = launch(&provider, Duration::from_secs(10)).await;
        let request = tokio::spawn(async move {
            response(
                session.clone(),
                &session.state,
                &browser(&session),
                ("code", "synthetic-code"),
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), provider.entered.notified())
            .await
            .unwrap();
        assert!(cancel());
        provider.release.notify_one();
        let result = request.await.unwrap();
        assert!(result.headers()[header::LOCATION]
            .to_str()
            .unwrap()
            .contains("calendar=error"));
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            original
        );
        store::reset_for_tests();
    }
    #[tokio::test]
    async fn refresh_is_client_bound_handles_revocation_and_keeps_source_web_form() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let _directory = fixture();
        let original = previous();
        let provider = Provider::start().await;
        let mut saved = integrations::read_tokens().unwrap().unwrap();
        saved.client_id = Some("other-client.apps.googleusercontent.com".into());
        assert!(
            integrations::refresh_token(saved.clone(), &provider.config())
                .await
                .is_err()
        );
        assert!(provider.forms.lock().unwrap().is_empty());
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            original
        );
        saved.client_id = Some(CLIENT.into());
        saved.expires_at = 42;
        let fresh = integrations::refresh_token(saved.clone(), &provider.config())
            .await
            .unwrap();
        assert_eq!(fresh.access_token, "synthetic-new-access");
        assert_eq!(
            provider.forms.lock().unwrap().last().unwrap()["client_secret"],
            "synthetic-web-secret"
        );
        provider.mode.store(4, Ordering::SeqCst);
        let unchanged = fs::read(integrations::credentials_file().unwrap()).unwrap();
        let diagnostic = integrations::refresh_token(saved.clone(), &provider.config())
            .await
            .unwrap_err();
        assert!(diagnostic.message.contains("invalid_client"));
        assert!(!diagnostic.message.contains("synthetic-private"));
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            unchanged
        );
        provider.mode.store(0, Ordering::SeqCst);
        saved.client_id = None;
        let fresh = integrations::refresh_token(saved.clone(), &provider.config())
            .await
            .unwrap();
        assert_eq!(fresh.client_id.as_deref(), Some(CLIENT));
        assert_eq!(
            provider.forms.lock().unwrap().last().unwrap()["client_secret"],
            "synthetic-web-secret"
        );
        let mut missing = fresh.clone();
        missing.expires_at = 42;
        missing.refresh_token = None;
        assert!(integrations::refresh_token(missing, &provider.config())
            .await
            .is_err());
        assert!(
            integrations::read_tokens()
                .unwrap()
                .unwrap()
                .reconnect_required
        );
        provider.mode.store(1, Ordering::SeqCst);
        saved.client_id = Some(CLIENT.into());
        assert!(
            integrations::refresh_token(saved.clone(), &provider.config())
                .await
                .is_err()
        );
        let revoked = integrations::read_tokens().unwrap().unwrap();
        assert!(revoked.reconnect_required);
        assert_eq!(revoked.access_token, saved.access_token);
        assert_eq!(revoked.refresh_token, saved.refresh_token);
        integrations::save_tokens(&fresh).unwrap();
        integrations::mark_revoked("older-token").unwrap();
        assert!(
            !integrations::read_tokens()
                .unwrap()
                .unwrap()
                .reconnect_required
        );
        integrations::mark_revoked(&fresh.access_token).unwrap();
        assert!(
            integrations::read_tokens()
                .unwrap()
                .unwrap()
                .reconnect_required
        );
        provider.mode.store(3, Ordering::SeqCst);
        let before = fs::read(integrations::credentials_file().unwrap()).unwrap();
        assert!(integrations::refresh_token(saved, &provider.config())
            .await
            .is_err());
        assert_eq!(
            fs::read(integrations::credentials_file().unwrap()).unwrap(),
            before
        );
        store::reset_for_tests();
    }
    #[tokio::test]
    async fn source_code_exchange_retains_web_secret_but_never_places_it_in_browser_url() {
        let _guard = store::TEST_LIBRARY_LOCK.lock().await;
        let _directory = fixture();
        previous();
        let provider = Provider::start().await;
        let response = begin(
            provider.config(),
            "http://localhost:3000".into(),
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        let auth = Url::parse(response.headers()[header::LOCATION].to_str().unwrap()).unwrap();
        let fields: HashMap<_, _> = auth.query_pairs().into_owned().collect();
        assert!(!fields.contains_key("client_secret"));
        *provider.challenge.lock().unwrap() = fields["code_challenge"].clone();
        let session = sessions().lock().unwrap().as_ref().unwrap().clone();
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{COOKIE}={}", session.browser.as_str())).unwrap(),
        );
        let result = callback(
            headers,
            Query(HashMap::from([
                ("state".into(), session.state.to_string()),
                ("code".into(), "synthetic-code".into()),
            ])),
        )
        .await;
        assert_eq!(
            result.headers()[header::LOCATION],
            "http://localhost:3000/?calendar=connected"
        );
        assert_eq!(
            provider.forms.lock().unwrap().last().unwrap()["client_secret"],
            "synthetic-web-secret"
        );
        assert!(!pending());
        store::reset_for_tests();
    }
}
