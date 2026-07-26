//! template-builder: converts an OCI image reference plus a recipe
//! into a bootable template artifact by unpacking layers and executing
//! recipe steps inside microVMs, with content-hash-keyed layer caching
//! (docs/components/template-builder.md). This is where the one boot
//! every sandbox resumes from happens.
//!
//! Stub: health endpoint and the middleware shell only. The build
//! pipeline — unpack, recipe execution, boot, warm-up, snapshot —
//! lands here; its output is a `template` artifact per
//! docs/architecture/snapshots.md.

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
