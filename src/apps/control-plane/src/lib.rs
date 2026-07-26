//! control-plane: the replicated API service that admits callers,
//! enforces quotas, places sandboxes onto nodes, owns the durable
//! catalog, and mints capability tokens — without ever sitting on the
//! data path (docs/components/control-plane.md).
//!
//! Stub: health endpoint and the middleware shell only. The route
//! surface implements src/contracts/openapi.yaml, which is the source of truth
//! and is reviewed by diff — routes land here as that document grows
//! implementation coverage.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use axum::{Router, http::StatusCode, response::IntoResponse, routing::get};
use tower_http::trace::TraceLayer;

/// Build the service router. Kept in the library half of the crate so
/// tests can drive it with `tower::ServiceExt` without binding a port.
pub fn router() -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .layer(TraceLayer::new_for_http())
}

async fn healthz() -> impl IntoResponse {
    StatusCode::OK
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use tower::ServiceExt as _;

    use super::*;

    #[tokio::test]
    async fn healthz_reports_ok() {
        let request = Request::builder()
            .uri("/healthz")
            .body(Body::from(""))
            .unwrap();
        let response = router().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
}
