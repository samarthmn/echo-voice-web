mod api;
mod chatgpt;
mod integrations;
mod notes;
mod security;
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
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "echo_server=info,tower_http=info".into()),
        )
        .init();
    store::init()?;
    let router = Router::new()
        .nest(
            "/api",
            api::routes()
                .merge(integrations::routes())
                .merge(notes::routes())
                .merge(chatgpt::routes())
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
    let bind = std::env::var("ECHO_BIND").unwrap_or_else(|_| "127.0.0.1:3000".to_string());
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("Echo Voice is ready at http://{}", bind);
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    chatgpt::shutdown().await;
    Ok(())
}
