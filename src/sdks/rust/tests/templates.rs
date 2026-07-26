//! Template build polling: wait() outcomes and log paging.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::Duration;

use common::client;
use fissionplane::models::{CreateTemplateBuildRequest, TemplateBuildStatus};
use fissionplane::{Error, WaitOptions};
use serde_json::json;
use wiremock::matchers::{body_json, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn build_json(status: &str) -> serde_json::Value {
    json!({
        "build_id": "b1",
        "status": status,
        "image": "docker.io/library/python:3.13",
        "created_at": "2026-07-28T12:00:00Z"
    })
}

/// Zero-interval polling so the tests do not sleep.
fn fast_poll(timeout: Option<Duration>) -> WaitOptions {
    WaitOptions {
        poll_interval: Duration::ZERO,
        timeout,
    }
}

#[tokio::test]
async fn build_wait_polls_to_success() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/templates/builds"))
        .and(body_json(json!({
            "image": "docker.io/library/python:3.13",
            "alias": "python"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(build_json("queued")))
        .mount(&server)
        .await;
    // Mount order decides: the first poll sees `building` once, every
    // later poll falls through to `succeeded`.
    Mock::given(method("GET"))
        .and(path("/v1/templates/builds/b1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(build_json("building")))
        .up_to_n_times(1)
        .mount(&server)
        .await;
    let mut succeeded = build_json("succeeded");
    succeeded["artifact_id"] = json!("art9");
    succeeded["image_digest"] = json!("sha256:abc");
    succeeded["finished_at"] = json!("2026-07-28T12:05:00Z");
    Mock::given(method("GET"))
        .and(path("/v1/templates/builds/b1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(succeeded))
        .mount(&server)
        .await;

    let mut build = client(&server)
        .templates()
        .build(CreateTemplateBuildRequest {
            image: "docker.io/library/python:3.13".to_owned(),
            alias: Some("python".to_owned()),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(build.info.status, TemplateBuildStatus::Queued);

    let done = build.wait(fast_poll(None)).await.unwrap();

    assert_eq!(done.status, TemplateBuildStatus::Succeeded);
    assert_eq!(done.artifact_id.as_deref(), Some("art9"));
    assert_eq!(build.info.status, TemplateBuildStatus::Succeeded);
}

#[tokio::test]
async fn build_wait_surfaces_the_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/templates/builds"))
        .respond_with(ResponseTemplate::new(201).set_body_json(build_json("queued")))
        .mount(&server)
        .await;
    let mut failed = build_json("failed");
    failed["error"] = json!("step 3 exited with status 1");
    Mock::given(method("GET"))
        .and(path("/v1/templates/builds/b1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(failed))
        .mount(&server)
        .await;

    let mut build = client(&server)
        .templates()
        .build(CreateTemplateBuildRequest {
            image: "docker.io/library/python:3.13".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();

    let error = build.wait(fast_poll(None)).await.unwrap_err();
    match error {
        Error::BuildFailed { error } => assert_eq!(error, "step 3 exited with status 1"),
        other => panic!("expected Error::BuildFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn build_wait_times_out_before_a_terminal_state() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/templates/builds"))
        .respond_with(ResponseTemplate::new(201).set_body_json(build_json("queued")))
        .mount(&server)
        .await;

    let mut build = client(&server)
        .templates()
        .build(CreateTemplateBuildRequest {
            image: "docker.io/library/python:3.13".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();

    // A zero timeout elapses before the first poll.
    let error = build
        .wait(fast_poll(Some(Duration::ZERO)))
        .await
        .unwrap_err();
    assert!(matches!(error, Error::WaitTimeout));
}

#[tokio::test]
async fn build_logs_pass_the_offset_through() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/templates/builds/b1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(build_json("building")))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v1/templates/builds/b1/logs"))
        .and(query_param("offset", "3"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "entries": [
                { "timestamp": "2026-07-28T12:01:00Z", "message": "step 4: pip install" },
                { "timestamp": "2026-07-28T12:01:02Z", "message": "step 4: done" }
            ],
            "next_offset": 5
        })))
        .expect(1)
        .mount(&server)
        .await;

    let build = client(&server).templates().get_build("b1").await.unwrap();
    let logs = build.logs(3).await.unwrap();

    assert_eq!(logs.entries.len(), 2);
    assert_eq!(logs.next_offset, 5);
    assert_eq!(logs.entries[1].message, "step 4: done");
}
