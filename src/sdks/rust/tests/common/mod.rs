//! Fixtures shared by the wiremock suites.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
// Each test binary compiles this module separately and uses a subset.
#![allow(dead_code)]

use fissionplane::{ClientOptions, FissionPlane};
use serde_json::json;
use wiremock::MockServer;

/// A minimal contract-shaped sandbox document.
pub fn sandbox_json(sandbox_id: &str, epoch: i64) -> serde_json::Value {
    json!({
        "sandbox_id": sandbox_id,
        "name": null,
        "state": "running",
        "template_artifact_id": "tmplart1",
        "template": "base",
        "epoch": epoch,
        "domain": "sandboxes.example.com",
        "created_at": "2026-07-28T12:00:00Z",
        "deadline": "2026-07-28T13:00:00Z",
        "metadata": {},
        "resources": { "vcpus": 2, "mem_mib": 1024 }
    })
}

/// A capability token document for `epoch`.
pub fn token_json(epoch: i64) -> serde_json::Value {
    json!({
        "token": format!("tok{epoch}"),
        "expires_at": "2026-07-28T12:10:00Z",
        "epoch": epoch,
        "ports": null
    })
}

/// A client pointed at the mock control plane, with an explicit key so
/// no environment variable is consulted.
pub fn client(server: &MockServer) -> FissionPlane {
    client_with(server, ClientOptions::new())
}

/// The same, with the caller's options applied first.
pub fn client_with(server: &MockServer, options: ClientOptions) -> FissionPlane {
    FissionPlane::new(options.api_key("test-key").base_url(server.uri())).unwrap()
}
