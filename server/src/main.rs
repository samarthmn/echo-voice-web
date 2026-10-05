mod api;
mod chatgpt;
mod config;
mod integrations;
mod notes;
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
    dotenvy::dotenv().ok();
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
    speech::recover_spools()?;
    config::runner_token(&store::data_dir())?;
    integrations::recover_bot_starts().await;
    let router = Router::new()
        .nest(
            "/api",
            api::routes()
                .merge(integrations::routes())
                .merge(notes::routes())
                .merge(chatgpt::routes())
                .merge(speech::routes())
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
        .fallback_service(
            ServeDir::new("public").not_found_service(ServeFile::new("public/index.html")),
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
    tracing::info!("Echo Voice is ready at http://{}", bind);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            speech::shutdown().await;
        })
        .await?;
    speech::shutdown().await;
    chatgpt::shutdown().await;
    Ok(())
}
