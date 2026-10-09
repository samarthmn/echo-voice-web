//! Private Unix control channel, deliberately absent from the HTTP router.
use crate::control_protocol::{Bootstrap, Request, Status, MAX_MESSAGE};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::Notify,
};
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static DRAINING: AtomicBool = AtomicBool::new(false);
pub async fn activity(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    if DRAINING.load(Ordering::SeqCst) && request.method() != axum::http::Method::GET {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "Echo is shutting down. Saved browser recordings can transfer after reopening Echo.",
        )
            .into_response();
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            ACTIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
    ACTIVE.fetch_add(1, Ordering::SeqCst);
    let _guard = Guard;
    next.run(request).await
}
pub struct Control {
    pub shutdown: Arc<Notify>,
    socket: Option<std::path::PathBuf>,
}
impl Drop for Control {
    fn drop(&mut self) {
        if let Some(path) = &self.socket {
            let _ = std::fs::remove_file(path);
        }
    }
}
pub async fn start(url: String) -> Result<Control, Box<dyn std::error::Error>> {
    let shutdown = Arc::new(Notify::new());
    if std::env::var("ECHO_CONTROL_STDIN").as_deref() != Ok("1") {
        return Ok(Control {
            shutdown,
            socket: None,
        });
    }
    // Tokio's stdin uses an uncancellable blocking task, which can keep runtime
    // destruction waiting forever while the parent waits for this child to exit.
    let (bootstrap_sender, bootstrap_receiver) = tokio::sync::oneshot::channel();
    let lease_shutdown = shutdown.clone();
    std::thread::spawn(move || {
        use std::io::{BufRead, Read};
        let mut stdin = std::io::stdin().lock();
        let mut line = String::new();
        let result = (&mut stdin)
            .take(MAX_MESSAGE as u64)
            .read_line(&mut line)
            .map(|_| line);
        let _ = bootstrap_sender.send(result);
        let mut lease = [0u8; 1];
        let _ = stdin.read(&mut lease);
        DRAINING.store(true, Ordering::SeqCst);
        lease_shutdown.notify_one();
    });
    let line =
        tokio::time::timeout(std::time::Duration::from_secs(3), bootstrap_receiver).await???;
    let auth: Bootstrap = serde_json::from_str(&line)?;
    if auth.secret.len() != 64
        || !auth.secret.bytes().all(|b| b.is_ascii_hexdigit())
        || uuid::Uuid::parse_str(&auth.instance_id).is_err()
    {
        return Err("Invalid private runtime bootstrap".into());
    }
    let socket = crate::paths::get().runtime_dir.join("s");
    if socket.exists() {
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    }
    let stopped = shutdown.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let auth = auth.clone();
            let url = url.clone();
            let stopped = stopped.clone();
            tokio::spawn(async move {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async move {
                    let (read, mut write) = stream.into_split();
                    let mut line = String::new();
                    BufReader::new(read)
                        .take(MAX_MESSAGE as u64)
                        .read_line(&mut line)
                        .await?;
                    let request: Request = serde_json::from_str(&line)?;
                    if !request.authentic(&auth) {
                        return Err::<(), Box<dyn std::error::Error + Send + Sync>>(
                            "Unauthenticated control request".into(),
                        );
                    }
                    let active_requests = ACTIVE.load(Ordering::SeqCst);
                    let active_processing = crate::store::list_meetings()?
                        .iter()
                        .filter(|m| {
                            matches!(
                                m["status"].as_str(),
                                Some("recording" | "paused" | "processing")
                            )
                        })
                        .count()
                        + crate::speech::active_count().await;
                    let quit = request.action == "shutdown"
                        && (request.force || active_requests + active_processing == 0);
                    if quit {
                        DRAINING.store(true, Ordering::SeqCst);
                    }
                    let status = Status {
                        version: 1,
                        instance_id: auth.instance_id.clone(),
                        nonce: request.nonce,
                        workspace_url: url,
                        active_requests,
                        active_processing,
                        shutting_down: DRAINING.load(Ordering::SeqCst),
                        mac: String::new(),
                    }
                    .signed(&auth);
                    let acknowledgement = write
                        .write_all(format!("{}\n", serde_json::to_string(&status)?).as_bytes())
                        .await;
                    if quit {
                        stopped.notify_one();
                    }
                    acknowledgement?;
                    Ok(())
                })
                .await;
            });
        }
    });
    Ok(Control {
        shutdown,
        socket: Some(socket),
    })
}
