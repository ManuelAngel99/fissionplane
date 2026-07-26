//! Filesystem data-plane behaviour against wiremock.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{sandbox_json, token_json};
use fissionplane::models::CreateSandboxRequest;
use fissionplane::{
    ClientOptions, FissionPlane, MakeDirectoryOptions, MovePathOptions, RemoveOptions, Url,
    WriteOptions,
};
use serde_json::json;
use wiremock::matchers::{body_bytes, body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn sandbox_with_dataplane() -> (MockServer, MockServer, fissionplane::Sandbox) {
    let control = MockServer::start().await;
    let dataplane = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "sandbox": sandbox_json("sbx1", 1),
            "token": token_json(1)
        })))
        .mount(&control)
        .await;
    let client = FissionPlane::new(
        ClientOptions::new()
            .api_key("test-key")
            .base_url(control.uri())
            .agent_base_url_override(Url::parse(&dataplane.uri()).unwrap()),
    )
    .unwrap();
    let sandbox = client
        .sandboxes()
        .create(
            CreateSandboxRequest {
                template: "base".to_owned(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    (control, dataplane, sandbox)
}

#[tokio::test]
async fn filesystem_operations_match_the_contract() {
    let (_control, dataplane, sandbox) = sandbox_with_dataplane().await;
    let file = json!({
        "path": "/workspace/a.txt",
        "name": "a.txt",
        "kind": "file",
        "size": 3,
        "mode": "0644",
        "modified_at": "2026-07-28T12:00:00Z"
    });
    Mock::given(method("GET"))
        .and(path("/files"))
        .and(query_param("path", "/workspace"))
        .and(header("X-Sandbox-Token", "tok1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [file.clone()] })))
        .mount(&dataplane)
        .await;
    Mock::given(method("GET"))
        .and(path("/files/stat"))
        .and(query_param("path", "/workspace/a.txt"))
        .respond_with(ResponseTemplate::new(200).set_body_json(file))
        .mount(&dataplane)
        .await;
    Mock::given(method("POST"))
        .and(path("/files/directories"))
        .and(body_json(json!({
            "path": "/workspace/new",
            "parents": true,
            "mode": "0755"
        })))
        .respond_with(ResponseTemplate::new(204))
        .mount(&dataplane)
        .await;
    Mock::given(method("POST"))
        .and(path("/files/move"))
        .and(body_json(json!({
            "source": "/workspace/a.txt",
            "destination": "/workspace/b.txt",
            "overwrite": true
        })))
        .respond_with(ResponseTemplate::new(204))
        .mount(&dataplane)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/files"))
        .and(query_param("path", "/workspace/new"))
        .and(query_param("recursive", "true"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&dataplane)
        .await;
    Mock::given(method("GET"))
        .and(path("/files/content"))
        .and(query_param("path", "/workspace/a.txt"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"abc"))
        .mount(&dataplane)
        .await;
    Mock::given(method("PUT"))
        .and(path("/files/content"))
        .and(query_param("path", "/workspace/c.bin"))
        .and(query_param("mode", "0600"))
        .and(header("Content-Type", "application/octet-stream"))
        .and(body_bytes(b"\0\xff".as_slice()))
        .respond_with(ResponseTemplate::new(204))
        .mount(&dataplane)
        .await;

    let files = sandbox.files().unwrap();
    assert_eq!(files.list("/workspace").await.unwrap().len(), 1);
    assert_eq!(files.stat("/workspace/a.txt").await.unwrap().name, "a.txt");
    files
        .make_dir(
            "/workspace/new",
            MakeDirectoryOptions {
                parents: true,
                mode: Some("0755".to_owned()),
            },
        )
        .await
        .unwrap();
    files
        .move_path(
            "/workspace/a.txt",
            "/workspace/b.txt",
            MovePathOptions { overwrite: true },
        )
        .await
        .unwrap();
    files
        .remove("/workspace/new", RemoveOptions { recursive: true })
        .await
        .unwrap();
    assert_eq!(files.download("/workspace/a.txt").await.unwrap(), b"abc");
    files
        .upload(
            "/workspace/c.bin",
            vec![0, 0xff],
            WriteOptions {
                mode: Some("0600".to_owned()),
            },
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_rejected_token_is_reminted_before_the_download_is_replayed() {
    let (control, dataplane, sandbox) = sandbox_with_dataplane().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes/sbx1/token"))
        .respond_with(ResponseTemplate::new(201).set_body_json(token_json(2)))
        .expect(1)
        .mount(&control)
        .await;
    Mock::given(method("GET"))
        .and(path("/files/content"))
        .and(header("X-Sandbox-Token", "tok1"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "code": "unauthenticated",
            "message": "expired token"
        })))
        .expect(1)
        .mount(&dataplane)
        .await;
    Mock::given(method("GET"))
        .and(path("/files/content"))
        .and(header("X-Sandbox-Token", "tok2"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"abc"))
        .expect(1)
        .mount(&dataplane)
        .await;

    let files = sandbox.files().unwrap();

    assert_eq!(files.read("/workspace/a.txt").await.unwrap(), b"abc");
    assert_eq!(sandbox.current_token().unwrap().token, "tok2");
}
