//! Control-plane behaviour against a mock server: headers, bodies,
//! error mapping, token re-arming, ports, and pagination.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::collections::BTreeMap;

use common::{client, sandbox_json, token_json};
use fissionplane::models::{CreateSandboxRequest, PortVisibility, SandboxState};
use fissionplane::{Error, ListSandboxesFilter};
use futures_util::StreamExt;
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path, query_param, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn create_sends_credentials_and_body_and_arms_the_handle() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .and(header("X-API-Key", "test-key"))
        .and(header("Idempotency-Key", "create-1"))
        .and(body_json(json!({
            "template": "base",
            "name": "demo",
            "metadata": { "run": "42" }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "sandbox": sandbox_json("sbx1", 1),
            "token": token_json(1)
        })))
        .expect(1)
        .mount(&server)
        .await;

    let request = CreateSandboxRequest {
        template: "base".to_owned(),
        name: Some("demo".to_owned()),
        metadata: Some(BTreeMap::from([("run".to_owned(), "42".to_owned())])),
        ..Default::default()
    };
    let sandbox = client(&server)
        .sandboxes()
        .create(request, Some("create-1"))
        .await
        .unwrap();

    assert_eq!(sandbox.info.sandbox_id, "sbx1");
    assert_eq!(sandbox.info.state, SandboxState::Running);
    let token = sandbox.token.unwrap();
    assert_eq!(token.epoch, 1);
    assert_eq!(token.token, "tok1");
}

#[tokio::test]
async fn create_name_conflict_maps_to_api_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "code": "name_taken",
            "message": "a sandbox named demo already exists",
            "retryable": false,
            "request_id": "req1"
        })))
        .mount(&server)
        .await;

    let request = CreateSandboxRequest {
        template: "base".to_owned(),
        name: Some("demo".to_owned()),
        ..Default::default()
    };
    let error = client(&server)
        .sandboxes()
        .create(request, None)
        .await
        .unwrap_err();

    match error {
        Error::Api {
            status,
            code,
            retryable,
            request_id,
            ..
        } => {
            assert_eq!(status, 409);
            assert_eq!(code.as_deref(), Some("name_taken"));
            assert!(!retryable);
            assert_eq!(request_id.as_deref(), Some("req1"));
        },
        other => panic!("expected Error::Api, got {other:?}"),
    }
}

#[tokio::test]
async fn resume_updates_info_and_rearms_the_token() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "sandbox": sandbox_json("sbx1", 1),
            "token": token_json(1)
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes/sbx1/resume"))
        .and(body_json(json!({ "deadline_seconds": 600 })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "sandbox": sandbox_json("sbx1", 2),
            "token": token_json(2)
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut sandbox = client(&server)
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
    assert_eq!(sandbox.token.as_ref().unwrap().epoch, 1);

    sandbox.resume(Some(600)).await.unwrap();

    assert_eq!(sandbox.info.epoch, 2);
    let token = sandbox.token.unwrap();
    assert_eq!(token.epoch, 2);
    assert_eq!(token.token, "tok2");
}

#[tokio::test]
async fn expose_and_unexpose_a_port() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)))
        .mount(&server)
        .await;
    Mock::given(method("PUT"))
        .and(path("/v1/sandboxes/sbx1/ports/8080"))
        .and(header("X-API-Key", "test-key"))
        .and(body_json(json!({ "visibility": "public" })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "port": 8080,
            "visibility": "public",
            "url": "https://8080-sbx1.sandboxes.example.com"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/v1/sandboxes/sbx1/ports/8080"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;

    let sandbox = client(&server).sandboxes().get("sbx1").await.unwrap();
    let ports = sandbox.ports();

    let exposure = ports.expose(8080, PortVisibility::Public).await.unwrap();
    assert_eq!(exposure.port, 8080);
    assert_eq!(exposure.visibility, PortVisibility::Public);
    assert_eq!(exposure.url, "https://8080-sbx1.sandboxes.example.com");

    ports.unexpose(8080).await.unwrap();
}

#[tokio::test]
async fn list_all_follows_the_cursor() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param("limit", "2"))
        .and(query_param_is_missing("cursor"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [sandbox_json("sbxa", 1), sandbox_json("sbxb", 1)],
            "next_cursor": "c1"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param("limit", "2"))
        .and(query_param("cursor", "c1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [sandbox_json("sbxc", 1)],
            "next_cursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let all = client(&server)
        .sandboxes()
        .list_all(ListSandboxesFilter {
            limit: Some(2),
            ..Default::default()
        })
        .await
        .unwrap();

    let ids: Vec<&str> = all.iter().map(|s| s.sandbox_id.as_str()).collect();
    assert_eq!(ids, ["sbxa", "sbxb", "sbxc"]);
}

#[tokio::test]
async fn stream_yields_every_page_in_order() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param("limit", "2"))
        .and(query_param_is_missing("cursor"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [sandbox_json("sbxa", 1), sandbox_json("sbxb", 1)],
            "next_cursor": "c1"
        })))
        .expect(1)
        .mount(&server)
        .await;
    // An empty middle page still carries the caller forward.
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param("cursor", "c1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [],
            "next_cursor": "c2"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param("cursor", "c2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [sandbox_json("sbxc", 1)],
            "next_cursor": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let sandboxes = client(&server).sandboxes();
    let stream = sandboxes.stream(ListSandboxesFilter {
        limit: Some(2),
        ..Default::default()
    });
    let ids: Vec<String> = stream
        .map(|sandbox| sandbox.unwrap().info.sandbox_id)
        .collect()
        .await;

    assert_eq!(ids, ["sbxa", "sbxb", "sbxc"]);
}

#[tokio::test]
async fn stream_surfaces_the_error_that_ended_it() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param_is_missing("cursor"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [sandbox_json("sbxa", 1)],
            "next_cursor": "c1"
        })))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .and(query_param("cursor", "c1"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({
            "code": "invalid_request",
            "message": "the cursor has expired",
            "retryable": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let sandboxes = client(&server).sandboxes();
    let pages: Vec<Result<String, Error>> = sandboxes
        .stream(ListSandboxesFilter::default())
        .map(|sandbox| sandbox.map(|sandbox| sandbox.info.sandbox_id))
        .collect()
        .await;

    assert_eq!(pages.len(), 2);
    assert_eq!(pages[0].as_deref().unwrap(), "sbxa");
    assert!(
        matches!(pages[1], Err(Error::Api { status: 400, .. })),
        "{:?}",
        pages[1]
    );
}

#[tokio::test]
async fn data_plane_modules_without_a_token_fail_closed() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)))
        .mount(&server)
        .await;

    // A handle from `get` carries no token.
    let sandbox = client(&server).sandboxes().get("sbx1").await.unwrap();
    assert!(matches!(sandbox.commands(), Err(Error::MissingToken)));
    assert!(matches!(sandbox.files(), Err(Error::MissingToken)));
}
