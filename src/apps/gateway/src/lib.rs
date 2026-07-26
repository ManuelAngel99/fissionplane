//! gateway: the stateless edge proxy that terminates wildcard TLS,
//! parses the sandbox subdomain, verifies capability tokens or scoped
//! cookies, and forwards traffic to the owning node
//! (docs/components/gateway.md).
//!
//! Stub: health endpoint and the middleware shell only. The design
//! rule that shapes everything that lands here later: the component is
//! deliberately the least interesting in the system — the minimum logic
//! that makes routing work, because every bug in it takes down the data
//! path for the whole installation at once.

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
