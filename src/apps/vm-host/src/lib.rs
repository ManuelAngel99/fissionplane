//! vm-host: the privileged per-node daemon that owns every Firecracker
//! process, per-sandbox networking, the node artifact cache, and the
//! sandbox data-plane API (docs/components/vm-host.md). It is the only
//! component in the system that talks to the hypervisor.
//!
//! Stub: health endpoint and the middleware shell only. The data-plane
//! surface implements src/contracts/dataplane.yaml, and the guest channel
//! speaks [`vm_protocol`] over vsock — the health answer already pins
//! the sealed protocol generation this build serves.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use axum::{Router, response::IntoResponse, routing::get};
use tower_http::trace::TraceLayer;
use vm_protocol::PROTOCOL_VERSION;

/// Build the service router. Kept in the library half of the crate so
/// tests can drive it with `tower::ServiceExt` without binding a port.
pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .layer(TraceLayer::new_for_http())
}

async fn healthz() -> impl IntoResponse {
    format!("ok; vm-protocol v{PROTOCOL_VERSION}\n")
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request, http::StatusCode};
    use tower::ServiceExt as _;

    use super::*;

    #[tokio::test]
    async fn healthz_reports_ok_and_protocol_generation() {
        let request = Request::builder()
            .uri("/healthz")
            .body(Body::from(""))
            .unwrap();
        let response = router().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1024)
            .await
            .unwrap();
        assert!(
            body.starts_with(b"ok; vm-protocol v"),
            "unexpected health answer: {body:?}"
        );
    }
}
