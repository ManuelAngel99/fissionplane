//! control-plane binary: serves the management API
//! (docs/components/control-plane.md). Replicas are interchangeable;
//! local dev binds $PORT (default 3000).

use std::net::SocketAddr;

use anyhow::{Context, Result};
use tokio::net::TcpListener;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(3000);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("bind {addr}"))?;

    info!(%addr, "control-plane listening");
    axum::serve(listener, control_plane::router())
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serve")
}

async fn shutdown_signal() {
    // SIGTERM arrives via Kubernetes pod termination; ctrl-c covers
    // local dev. An error here means the signal handler itself failed
    // to install, in which case shutdown simply falls back to SIGKILL.
    let _ = tokio::signal::ctrl_c().await;
}
