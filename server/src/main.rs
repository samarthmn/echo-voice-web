mod api;
mod chatgpt;
mod config;
#[cfg(unix)]
mod control_protocol;
mod extensions;
mod integrations;
mod legacy;
mod library_schema;
mod library_validation;
mod notes;
mod paths;
mod protected_storage;
mod recovery;
#[cfg(unix)]
mod runtime_control;
mod security;
mod speech;
mod store;
use axum::{
    http::{header, HeaderValue},
    Router,
};
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

#[tokio::main]
/// Initialize the local library and integrations, serve the workspace, and shut down the helper gracefully.
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !paths::installed() {
        dotenvy::dotenv().ok();
    }
    let runtime_paths = paths::RuntimePaths::resolve().map_err(|e| e.to_string())?;
    runtime_paths.prepare().map_err(|e| e.to_string())?;
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
    store::init()?;
    if std::env::args().nth(1).as_deref() == Some("--check-library") {
        library_validation::verify()?;
        legacy::validate_copy()?;
        if std::env::args().nth(2).as_deref() == Some("--copy-connection") {
            use std::io::Read;
            #[derive(serde::Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct ConnectionCopy {
                chatgpt_source_root: std::path::PathBuf,
                chatgpt_destination_root: std::path::PathBuf,
            }
            let mut input = zeroize::Zeroizing::new(String::new());
            std::io::stdin().take(16_385).read_to_string(&mut input)?;
            if input.len() > 16_384 {
                return Err("Library connection-copy input is too long.".into());
            }
            let selected: ConnectionCopy = serde_json::from_str(&input)
                .map_err(|_| "Invalid library connection-copy selection.")?;
            chatgpt::copy_connection(
                &selected.chatgpt_source_root,
                &selected.chatgpt_destination_root,
            )?;
        }
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
                .merge(legacy::routes())
                .route(
                    "/demo",
                    axum::routing::get(|| async {
                        axum::Json(
                            serde_json::from_str::<serde_json::Value>(include_str!(
                                "../../public/demo-meeting.json"
                            ))
                            .unwrap(),
                        )
                    }),
                )
                .layer(axum::middleware::from_fn(security::local_access)),
        )
        .nest("/extension/v1", extensions::extension_routes())
        .fallback_service(
            ServeDir::new(runtime_paths.resource_root.join("public")).not_found_service(
                ServeFile::new(runtime_paths.resource_root.join("public/index.html")),
            ),
        )
        .layer(axum::middleware::from_fn(security::browser_isolation))
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
    let listener = tokio::net::TcpListener::bind(bind).await?;
    #[cfg(unix)]
    let control = runtime_control::start(format!("http://localhost:{}", bind.port())).await?;
    #[cfg(unix)]
    let router = router.layer(axum::middleware::from_fn(runtime_control::activity));
    #[cfg(unix)]
    let shutdown = control.shutdown.clone();
    tracing::info!("Echo Voice is ready at http://{}", bind);
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            tokio::select! { _=tokio::signal::ctrl_c()=>{},_=shutdown.notified()=>{} }
            #[cfg(not(unix))]
            let _ = tokio::signal::ctrl_c().await;
            integrations::shutdown();
            speech::shutdown().await;
        })
        .await?;
    integrations::shutdown();
    speech::shutdown().await;
    chatgpt::shutdown().await;
    Ok(())
}
