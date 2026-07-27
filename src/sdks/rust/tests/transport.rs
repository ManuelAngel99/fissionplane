//! Transport behaviour shared by every operation: the request timeout,
//! the SDK's `User-Agent`, the bounded retry loop, and credential
//! validation.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::{client, client_with, sandbox_json, token_json};
use fissionplane::models::{CreateSandboxRequest, RunCommandRequest};
use fissionplane::{ClientOptions, Error, FissionPlane, ListSandboxesFilter, Url};
use serde_json::json;
use tracing::Level;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// The `User-Agent` the SDK sends when the caller configures none.
const SDK_USER_AGENT: &str = concat!("fissionplane-rust/", env!("CARGO_PKG_VERSION"));

/// A response that fails `failures` times before succeeding, counting
/// every call it serves.
fn flaky(
    failures: usize,
    failure: ResponseTemplate,
    success: ResponseTemplate,
) -> (Arc<AtomicUsize>, impl Fn(&Request) -> ResponseTemplate) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let responder = move |_: &Request| {
        if counter.fetch_add(1, Ordering::SeqCst) < failures {
            failure.clone()
        } else {
            success.clone()
        }
    };
    (calls, responder)
}

fn unavailable(retryable: Option<bool>) -> ResponseTemplate {
    let mut body = json!({ "code": "no_capacity", "message": "try again" });
    if let Some(retryable) = retryable {
        body["retryable"] = json!(retryable);
    }
    ResponseTemplate::new(503).set_body_json(body)
}

/// Collects a subscriber's formatted output so a test can read it back.
struct Recorder(Arc<Mutex<Vec<u8>>>);

impl io::Write for Recorder {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn sandbox_with_token() -> ResponseTemplate {
    ResponseTemplate::new(201).set_body_json(json!({
        "sandbox": sandbox_json("sbx1", 1),
        "token": token_json(1)
    }))
}

fn create(template: &str) -> CreateSandboxRequest {
    CreateSandboxRequest {
        template: template.to_owned(),
        ..Default::default()
    }
}

#[tokio::test]
async fn the_request_timeout_gives_up_on_a_slow_control_plane() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(sandbox_json("sbx1", 1))
                .set_delay(Duration::from_secs(30)),
        )
        .mount(&server)
        .await;

    let error = client_with(
        &server,
        ClientOptions::new()
            .request_timeout(Duration::from_millis(50))
            .max_retries(0),
    )
    .sandboxes()
    .get("sbx1")
    .await
    .unwrap_err();

    match error {
        Error::Http(source) => assert!(source.is_timeout(), "expected a timeout, got {source}"),
        other => panic!("expected Error::Http, got {other:?}"),
    }
}

#[tokio::test]
async fn the_request_timeout_also_bounds_the_data_plane() {
    let control = MockServer::start().await;
    let dataplane = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .respond_with(sandbox_with_token())
        .mount(&control)
        .await;
    Mock::given(method("POST"))
        .and(path("/commands"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({ "exit_code": 0, "stdout": "", "stderr": "" }))
                .set_delay(Duration::from_secs(30)),
        )
        .mount(&dataplane)
        .await;

    let client = FissionPlane::new(
        ClientOptions::new()
            .api_key("test-key")
            .base_url(control.uri())
            .agent_base_url_override(Url::parse(&dataplane.uri()).unwrap())
            .request_timeout(Duration::from_millis(50))
            .max_retries(0),
    )
    .unwrap();
    let sandbox = client
        .sandboxes()
        .create(create("base"), None)
        .await
        .unwrap();
    let error = sandbox
        .commands()
        .unwrap()
        .run(RunCommandRequest {
            command: "sleep".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap_err();

    match error {
        Error::Http(source) => assert!(source.is_timeout(), "expected a timeout, got {source}"),
        other => panic!("expected Error::Http, got {other:?}"),
    }
}

#[tokio::test]
async fn every_request_carries_the_sdk_user_agent() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .and(header("User-Agent", SDK_USER_AGENT))
        .respond_with(ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)))
        .expect(1)
        .mount(&server)
        .await;

    client(&server).sandboxes().get("sbx1").await.unwrap();
}

#[tokio::test]
async fn a_configured_user_agent_replaces_the_default() {
    let control = MockServer::start().await;
    let dataplane = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .and(header("User-Agent", "acme-batch/2.1"))
        .respond_with(sandbox_with_token())
        .expect(1)
        .mount(&control)
        .await;
    // The override reaches the data plane too.
    Mock::given(method("GET"))
        .and(path("/processes"))
        .and(header("User-Agent", "acme-batch/2.1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [] })))
        .expect(1)
        .mount(&dataplane)
        .await;

    let client = FissionPlane::new(
        ClientOptions::new()
            .api_key("test-key")
            .base_url(control.uri())
            .agent_base_url_override(Url::parse(&dataplane.uri()).unwrap())
            .user_agent("acme-batch/2.1"),
    )
    .unwrap();
    let sandbox = client
        .sandboxes()
        .create(create("base"), None)
        .await
        .unwrap();
    assert!(
        sandbox
            .commands()
            .unwrap()
            .list_processes()
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn a_read_is_replayed_until_it_succeeds() {
    let server = MockServer::start().await;
    let (calls, responder) = flaky(
        2,
        unavailable(None),
        ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)),
    );
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let sandbox = client(&server).sandboxes().get("sbx1").await.unwrap();

    assert_eq!(sandbox.info.sandbox_id, "sbx1");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        3,
        "two retries after the first attempt"
    );
}

#[tokio::test]
async fn replays_stop_at_the_configured_budget() {
    let server = MockServer::start().await;
    let (calls, responder) = flaky(
        usize::MAX,
        unavailable(None),
        ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)),
    );
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let error = client_with(&server, ClientOptions::new().max_retries(1))
        .sandboxes()
        .get("sbx1")
        .await
        .unwrap_err();

    assert!(matches!(error, Error::Api { status: 503, .. }), "{error:?}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        2,
        "one retry after the first attempt"
    );
}

#[tokio::test]
async fn max_retries_zero_sends_one_attempt() {
    let server = MockServer::start().await;
    let (calls, responder) = flaky(
        usize::MAX,
        unavailable(None),
        ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)),
    );
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let error = client_with(&server, ClientOptions::new().max_retries(0))
        .sandboxes()
        .get("sbx1")
        .await
        .unwrap_err();

    assert!(matches!(error, Error::Api { status: 503, .. }), "{error:?}");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_error_the_server_calls_final_is_not_replayed() {
    let server = MockServer::start().await;
    let (calls, responder) = flaky(
        1,
        unavailable(Some(false)),
        ResponseTemplate::new(200).set_body_json(sandbox_json("sbx1", 1)),
    );
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes/sbx1"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let error = client(&server).sandboxes().get("sbx1").await.unwrap_err();

    assert!(
        matches!(
            error,
            Error::Api {
                retryable: false,
                ..
            }
        ),
        "{error:?}"
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "`retryable: false` is the server's decision"
    );
}

#[tokio::test]
async fn a_create_without_an_idempotency_key_is_never_replayed() {
    let server = MockServer::start().await;
    let (calls, responder) = flaky(1, unavailable(None), sandbox_with_token());
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let error = client(&server)
        .sandboxes()
        .create(create("base"), None)
        .await
        .unwrap_err();

    assert!(matches!(error, Error::Api { status: 503, .. }), "{error:?}");
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a replayed create could produce a second sandbox"
    );
}

#[tokio::test]
async fn a_create_with_an_idempotency_key_is_replayed() {
    let server = MockServer::start().await;
    let (calls, responder) = flaky(1, unavailable(None), sandbox_with_token());
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .and(header("Idempotency-Key", "create-1"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let sandbox = client(&server)
        .sandboxes()
        .create(create("base"), Some("create-1"))
        .await
        .unwrap();

    assert_eq!(sandbox.info.sandbox_id, "sbx1");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "current_thread")]
async fn debug_events_report_a_replay_and_a_page_fetch() {
    let server = MockServer::start().await;
    let (_, responder) = flaky(
        1,
        unavailable(None),
        ResponseTemplate::new(200).set_body_json(json!({ "items": [], "next_cursor": null })),
    );
    Mock::given(method("GET"))
        .and(path("/v1/sandboxes"))
        .respond_with(responder)
        .mount(&server)
        .await;

    let log = Arc::new(Mutex::new(Vec::new()));
    let writer = Arc::clone(&log);
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(Level::DEBUG)
        .with_writer(move || Recorder(Arc::clone(&writer)))
        .finish();
    // The default Tokio test runtime is current-thread, but keep that explicit:
    // tracing's scoped default is thread-local and must remain on this thread
    // while the request yields between attempts.
    let _subscriber = tracing::subscriber::set_default(subscriber);
    client(&server)
        .sandboxes()
        .list(ListSandboxesFilter::default())
        .await
        .unwrap();

    let events = String::from_utf8(log.lock().unwrap().clone()).unwrap();
    assert!(events.contains("fetching a page of sandboxes"), "{events}");
    assert!(events.contains("replaying a failed request"), "{events}");
}

#[test]
fn an_empty_credential_is_rejected_with_configuration_advice() {
    let error = FissionPlane::new(ClientOptions::new().api_key("")).unwrap_err();

    match error {
        Error::Config(message) => {
            assert!(message.contains("empty"), "{message}");
            assert!(message.contains("FISSIONPLANE_API_KEY"), "{message}");
        },
        other => panic!("expected Error::Config, got {other:?}"),
    }
}

#[test]
fn a_credential_carrying_whitespace_is_rejected() {
    let error = FissionPlane::new(ClientOptions::new().api_key("sk-example\n")).unwrap_err();

    match error {
        Error::Config(message) => assert!(message.contains("whitespace"), "{message}"),
        other => panic!("expected Error::Config, got {other:?}"),
    }

    let error = FissionPlane::new(ClientOptions::new().access_token("two words")).unwrap_err();

    match error {
        Error::Config(message) => {
            assert!(message.contains("access token"), "{message}");
            assert!(message.contains("whitespace"), "{message}");
        },
        other => panic!("expected Error::Config, got {other:?}"),
    }
}
