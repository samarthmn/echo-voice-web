#![cfg_attr(not(test), deny(clippy::unwrap_used, clippy::expect_used))]
mod api;
mod chatgpt;
mod config;
mod extensions;
mod integrations;
mod library_schema;
mod library_validation;
mod notes;
mod paths;
mod protected_storage;
mod recovery;
mod security;
mod speech;
mod store;
use axum::{
    http::{header, HeaderValue},
    Router,
};
use std::future::IntoFuture;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

async fn not_found() -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
    (
        axum::http::StatusCode::NOT_FOUND,
        axum::Json(serde_json::json!({"error": "Not found"})),
    )
}

/// Bound runtime teardown even when an in-flight blocking operation cannot be cancelled.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    runtime.shutdown_timeout(std::time::Duration::from_millis(100));
    result
}

/// Initialize the local library and integrations, serve the workspace, and shut down the helper gracefully.
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = paths::resource_root().map_err(|e| e.to_string())?;
    dotenvy::from_path(root.join(".env")).ok();
    config::init(&root).map_err(|e| e.to_string())?;
    let runtime_paths = paths::RuntimePaths::resolve_at(root).map_err(|e| e.to_string())?;
    paths::private_directory(&runtime_paths.runtime_dir).map_err(|e| e.to_string())?;
    paths::init(runtime_paths.clone());
    if std::env::args().nth(1).as_deref() == Some("--recover-library") {
        use std::io::Read;
        let mut input = zeroize::Zeroizing::new(String::new());
        std::io::stdin().take(4097).read_to_string(&mut input)?;
        if input.len() > 4096 {
            return Err("Recovery input is too long.".into());
        }
        let value: serde_json::Value =
            serde_json::from_str(&input).map_err(|_| "Enter a valid library recovery phrase.")?;
        let phrase = value
            .get("phrase")
            .and_then(serde_json::Value::as_str)
            .ok_or("Enter the library recovery phrase.")?;
        recovery::recover_library(&runtime_paths.data_dir, phrase)?;
        println!("Library recovery completed. Reopen Echo.");
        return Ok(());
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "echo_server=info,tower_http=info".into()),
        )
        .init();
    let bind = config::loopback_bind(
        &std::env::var("ECHO_BIND").unwrap_or_else(|_| config::get().bind.clone()),
    )?;
    tracing::info!(%bind, data_dir = %runtime_paths.data_dir.display(), resource_root = %runtime_paths.resource_root.display(), redirect_uri = %config::redirect_uri(), "Echo runtime configuration");
    store::init()?;
    if std::env::args().nth(1).as_deref() == Some("--check-library") {
        library_validation::verify()?;
        println!("Library validation completed.");
        return Ok(());
    }
    speech::recover_spools()?;
    let router = Router::new()
        .nest(
            "/api",
            api::routes()
                .merge(recovery::routes())
                .merge(integrations::routes())
                .merge(notes::routes())
                .merge(chatgpt::routes())
                .merge(speech::routes())
                .merge(extensions::workspace_routes())
                .route(
                    "/demo",
                    axum::routing::get(|| async {
                        serde_json::from_str::<serde_json::Value>(include_str!(
                            "../../public/demo-meeting.json"
                        ))
                        .map(axum::Json)
                        .map_err(|error| {
                            tracing::error!(%error, "Invalid bundled demo meeting");
                            security::ApiError::new(500, "The demo meeting is unavailable.")
                        })
                    }),
                )
                .fallback(not_found)
                .layer(axum::middleware::from_fn(security::local_access)),
        )
        .nest(
            "/extension/v1",
            extensions::extension_routes().fallback(not_found),
        )
        .fallback_service(
            ServeDir::new(runtime_paths.resource_root.join("public")).not_found_service(
                ServeFile::new(runtime_paths.resource_root.join("public/index.html")),
            ),
        )
        .layer(axum::middleware::from_fn(security::browser_isolation))
        .layer(axum::middleware::from_fn(security::canonical_host))
        // Fixed asset URLs must revalidate after a local rebuild or packaged update.
        // API responses already specify no-store in the local-access middleware.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-cache"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ));
    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(format!("Port {} is already in use. Stop the other process (lsof -nP -iTCP:{} -sTCP:LISTEN) or set ECHO_BIND=127.0.0.1:<other>.", bind.port(), bind.port()).into());
        }
        Err(error) => return Err(error.into()),
    };
    tokio::spawn(extensions::cleanup_pairing_loop());
    tracing::info!("Echo Voice is ready at http://{}", bind);
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, router).with_graceful_shutdown(async {
        let _ = shutdown_rx.await;
    });
    let server = server.into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result?,
        _ = shutdown_signal() => {
            chatgpt::begin_shutdown();
            let _ = shutdown_tx.send(());
            if tokio::time::timeout(std::time::Duration::from_secs(10), &mut server).await.is_err() {
                tracing::warn!("Server drain exceeded shutdown deadline");
            }
            let limit = std::time::Duration::from_secs(5);
            let (integration_result, speech_result, chatgpt_result) = tokio::join!(
                tokio::time::timeout(limit, tokio::task::spawn_blocking(integrations::shutdown)),
                tokio::time::timeout(limit, speech::shutdown()),
                tokio::time::timeout(limit, chatgpt::shutdown()),
            );
            if integration_result.is_err() || speech_result.is_err() || chatgpt_result.is_err() {
                tracing::warn!("Shutdown cleanup exceeded its deadline");
            }
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = signal.recv() => {} }
            }
            Err(error) => {
                tracing::error!(%error, "Cannot register SIGTERM handler");
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
