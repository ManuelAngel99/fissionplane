//! Data-plane behaviour against a second mock server standing in for
//! the sandbox agent, reached through the client's
//! `agent_base_url_override`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{sandbox_json, token_json};
use fissionplane::models::{CreateSandboxRequest, PtySize, RunCommandRequest, StartProcessRequest};
use fissionplane::{ClientOptions, Error, FissionPlane, Sandbox, Signal, Url};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path, query_param, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A sandbox created against a mock control plane, with the data
/// plane pointed at a second mock server. Both servers are returned so
/// they outlive the handle.
async fn sandbox_with_dataplane() -> (MockServer, MockServer, Sandbox) {
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
async fn run_sends_the_token_and_maps_the_result() {
    let (_control, dataplane, sandbox) = sandbox_with_dataplane().await;
    Mock::given(method("POST"))
        .and(path("/commands"))
        .and(header("X-Sandbox-Token", "tok1"))
        .and(body_json(json!({ "command": "echo", "args": ["hi"] })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "exit_code": 0,
            "stdout": "hi\n",
            "stderr": "",
            "truncated": false
        })))
        .expect(1)
        .mount(&dataplane)
        .await;

    let result = sandbox
        .commands()
        .unwrap()
        .run(RunCommandRequest {
            command: "echo".to_owned(),
            args: Some(vec!["hi".to_owned()]),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(result.exit_code, 0);
    assert_eq!(result.stdout, "hi\n");
    assert_eq!(result.stderr, "");
    assert_eq!(result.truncated, Some(false));
}

#[tokio::test]
async fn a_rejected_token_is_reminted_and_the_call_replayed() {
    let (control, dataplane, sandbox) = sandbox_with_dataplane().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes/sbx1/token"))
        .and(header("X-API-Key", "test-key"))
        .respond_with(ResponseTemplate::new(201).set_body_json(token_json(2)))
        .expect(1)
        .mount(&control)
        .await;
    Mock::given(method("POST"))
        .and(path("/commands"))
        .and(header("X-Sandbox-Token", "tok1"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "code": "unauthenticated",
            "message": "the token was minted against a previous epoch"
        })))
        .expect(1)
        .mount(&dataplane)
        .await;
    Mock::given(method("POST"))
        .and(path("/commands"))
        .and(header("X-Sandbox-Token", "tok2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "exit_code": 0,
            "stdout": "hi\n",
            "stderr": ""
        })))
        .expect(1)
        .mount(&dataplane)
        .await;

    let result = sandbox
        .commands()
        .unwrap()
        .run(RunCommandRequest {
            command: "echo".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();

    assert_eq!(result.stdout, "hi\n");
    // The handle, and so every module built from it, now holds the
    // token the refresh minted.
    let token = sandbox.current_token().unwrap();
    assert_eq!(token.token, "tok2");
    assert_eq!(token.epoch, 2);
}

#[tokio::test]
async fn a_token_the_control_plane_will_not_remint_surfaces_that_failure() {
    let (control, dataplane, sandbox) = sandbox_with_dataplane().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes/sbx1/token"))
        .respond_with(ResponseTemplate::new(409).set_body_json(json!({
            "code": "lifecycle_conflict",
            "message": "the sandbox is paused",
            "retryable": false
        })))
        .expect(1)
        .mount(&control)
        .await;
    Mock::given(method("POST"))
        .and(path("/commands"))
        .respond_with(ResponseTemplate::new(401).set_body_json(json!({
            "code": "unauthenticated",
            "message": "expired token"
        })))
        .expect(1)
        .mount(&dataplane)
        .await;

    let error = sandbox
        .commands()
        .unwrap()
        .run(RunCommandRequest {
            command: "echo".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap_err();

    match error {
        Error::Api { status, code, .. } => {
            assert_eq!(status, 409);
            assert_eq!(code.as_deref(), Some("lifecycle_conflict"));
        },
        other => panic!("expected the mint failure, got {other:?}"),
    }
}

#[tokio::test]
async fn run_overrun_maps_the_data_plane_408() {
    let (_control, dataplane, sandbox) = sandbox_with_dataplane().await;
    Mock::given(method("POST"))
        .and(path("/commands"))
        .respond_with(ResponseTemplate::new(408).set_body_json(json!({
            "code": "command_timeout",
            "message": "the command did not exit within 5 seconds; it has been killed",
            "retryable": false
        })))
        .mount(&dataplane)
        .await;

    let error = sandbox
        .commands()
        .unwrap()
        .run(RunCommandRequest {
            command: "sleep".to_owned(),
            args: Some(vec!["3600".to_owned()]),
            timeout_seconds: Some(5),
            ..Default::default()
        })
        .await
        .unwrap_err();

    match error {
        Error::Api {
            status,
            code,
            retryable,
            ..
        } => {
            assert_eq!(status, 408);
            assert_eq!(code.as_deref(), Some("command_timeout"));
            assert!(!retryable);
        },
        other => panic!("expected Error::Api, got {other:?}"),
    }
}

#[tokio::test]
async fn list_processes_and_kill() {
    let (_control, dataplane, sandbox) = sandbox_with_dataplane().await;
    Mock::given(method("GET"))
        .and(path("/processes"))
        .and(header("X-Sandbox-Token", "tok1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [
                {
                    "pid": 42,
                    "command": "python server.py",
                    "started_at": "2026-07-28T12:01:00Z",
                    "running": true,
                    "pty": false,
                    "exit_code": null,
                    "exited_at": null
                }
            ]
        })))
        .mount(&dataplane)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/processes/42"))
        .and(query_param("signal", "SIGKILL"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&dataplane)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/processes/42"))
        .and(query_param_is_missing("signal"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&dataplane)
        .await;

    let commands = sandbox.commands().unwrap();

    let processes = commands.list_processes().await.unwrap();
    assert_eq!(processes.len(), 1);
    assert_eq!(processes[0].pid, 42);
    assert_eq!(processes[0].command, "python server.py");

    commands.kill(42, Some(Signal::Kill)).await.unwrap();
    // No signal parameter means the server default (SIGTERM).
    commands.kill(42, None).await.unwrap();
}

#[tokio::test]
async fn start_get_and_logs_return_process_handles() {
    let (_control, dataplane, sandbox) = sandbox_with_dataplane().await;
    let process = json!({
        "pid": 42,
        "command": "python server.py",
        "started_at": "2026-07-28T12:01:00Z",
        "running": true,
        "pty": true,
        "exit_code": null,
        "exited_at": null
    });
    Mock::given(method("POST"))
        .and(path("/processes"))
        .and(body_json(json!({
            "command": "python",
            "args": ["server.py"],
            "pty": { "cols": 120, "rows": 40 }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(process.clone()))
        .mount(&dataplane)
        .await;
    Mock::given(method("GET"))
        .and(path("/processes/42"))
        .respond_with(ResponseTemplate::new(200).set_body_json(process))
        .mount(&dataplane)
        .await;
    Mock::given(method("GET"))
        .and(path("/processes/42/logs"))
        .and(query_param("after", "7"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "chunks": [{ "stream": "stdout", "sequence": 8, "data": "ready\n" }],
            "next_sequence": 8,
            "running": true,
            "exit_code": null,
            "truncated_before": 3
        })))
        .mount(&dataplane)
        .await;

    let commands = sandbox.commands().unwrap();
    let mut handle = commands
        .start(StartProcessRequest {
            command: "python".to_owned(),
            args: Some(vec!["server.py".to_owned()]),
            pty: Some(PtySize {
                cols: 120,
                rows: 40,
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(handle.pid(), 42);
    assert!(handle.info.pty);
    assert_eq!(handle.logs(Some(7)).await.unwrap().chunks[0].sequence, 8);
    assert_eq!(handle.refresh().await.unwrap().pid, 42);
    assert_eq!(commands.get(42).await.unwrap().pid(), 42);
}
