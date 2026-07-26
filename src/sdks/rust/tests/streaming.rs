//! Local WebSocket coverage for process attachment.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(clippy::result_large_err)]

mod common;

use common::{sandbox_json, token_json};
use fissionplane::models::{CreateSandboxRequest, ProcessStreamEvent};
use fissionplane::{ClientOptions, FissionPlane, Signal, Url};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio::net::TcpListener;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::protocol::Message;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn process_attachment_uses_contract_url_protocols_and_frames() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(stream, |request: &Request, mut response: Response| {
            assert_eq!(
                request.uri().path_and_query().unwrap().as_str(),
                "/processes/42/stream?after=7"
            );
            assert_eq!(
                request
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .unwrap()
                    .to_str()
                    .unwrap(),
                "fissionplane.v1, fissionplane.token.dG9rMQ"
            );
            response.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_static("fissionplane.v1"),
            );
            Ok(response)
        })
        .await
        .unwrap();

        let mut outbound = Vec::new();
        for _ in 0..4 {
            let message = socket.next().await.unwrap().unwrap();
            let Message::Text(text) = message else {
                panic!("expected text frame");
            };
            outbound.push(serde_json::from_str::<serde_json::Value>(text.as_str()).unwrap());
        }
        assert_eq!(
            outbound,
            vec![
                json!({ "type": "input", "data": "yes\n" }),
                json!({ "type": "resize", "cols": 120, "rows": 40 }),
                json!({ "type": "signal", "signal": "SIGINT" }),
                json!({ "type": "close_stdin" }),
            ]
        );
        socket
            .send(Message::Text(r#"{"type":"future_event","value":1}"#.into()))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"stdout","sequence":8,"data":"ready\n"}"#.into(),
            ))
            .await
            .unwrap();
    });

    let control = MockServer::start().await;
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
            .agent_base_url_override(Url::parse(&format!("http://{address}")).unwrap()),
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

    let mut attachment = sandbox.commands().unwrap().attach(42, 7).await.unwrap();
    attachment.send_input("yes\n").await.unwrap();
    attachment.resize(120, 40).await.unwrap();
    attachment.signal(Signal::Int).await.unwrap();
    attachment.close_stdin().await.unwrap();
    let event = attachment.next().await.unwrap().unwrap();
    assert!(matches!(
        event,
        ProcessStreamEvent::Stdout {
            sequence: 8,
            ref data
        } if data == "ready\n"
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn a_handshake_rejected_for_the_token_reconnects_with_a_fresh_one() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        // The first handshake carries the stale token: reject it the way
        // the gateway does, before any WebSocket upgrade.
        let (rejected, _) = listener.accept().await.unwrap();
        let request = read_request(&rejected).await;
        assert!(
            request.contains("fissionplane.token.dG9rMQ"),
            "expected the stale token, got {request}"
        );
        write_all(
            &rejected,
            b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n",
        )
        .await;
        drop(rejected);

        // The retry must carry the token the control plane just minted.
        let (accepted, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(accepted, |request: &Request, mut response: Response| {
            assert_eq!(
                request
                    .headers()
                    .get(SEC_WEBSOCKET_PROTOCOL)
                    .unwrap()
                    .to_str()
                    .unwrap(),
                "fissionplane.v1, fissionplane.token.dG9rMg"
            );
            response.headers_mut().insert(
                SEC_WEBSOCKET_PROTOCOL,
                HeaderValue::from_static("fissionplane.v1"),
            );
            Ok(response)
        })
        .await
        .unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"stdout","sequence":1,"data":"back\n"}"#.into(),
            ))
            .await
            .unwrap();
    });

    let control = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "sandbox": sandbox_json("sbx1", 1),
            "token": token_json(1)
        })))
        .mount(&control)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/sandboxes/sbx1/token"))
        .respond_with(ResponseTemplate::new(201).set_body_json(token_json(2)))
        .expect(1)
        .mount(&control)
        .await;
    let client = FissionPlane::new(
        ClientOptions::new()
            .api_key("test-key")
            .base_url(control.uri())
            .agent_base_url_override(Url::parse(&format!("http://{address}")).unwrap()),
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

    let mut attachment = sandbox.commands().unwrap().attach(42, 0).await.unwrap();
    let event = attachment.next().await.unwrap().unwrap();
    assert!(matches!(
        event,
        ProcessStreamEvent::Stdout {
            sequence: 1,
            ref data
        } if data == "back\n"
    ));
    assert_eq!(sandbox.current_token().unwrap().token, "tok2");
    server.await.unwrap();
}

/// Reads one HTTP request head off `stream` without pulling in
/// `tokio`'s `io-util` extension traits.
async fn read_request(stream: &tokio::net::TcpStream) -> String {
    let mut request = Vec::new();
    loop {
        stream.readable().await.unwrap();
        let mut chunk = [0_u8; 1024];
        match stream.try_read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                request.extend_from_slice(&chunk[..read]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => panic!("reading the handshake: {error}"),
        }
    }
    String::from_utf8_lossy(&request).into_owned()
}

async fn write_all(stream: &tokio::net::TcpStream, mut bytes: &[u8]) {
    while !bytes.is_empty() {
        stream.writable().await.unwrap();
        match stream.try_write(bytes) {
            Ok(written) => bytes = &bytes[written..],
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(error) => panic!("writing the rejection: {error}"),
        }
    }
}
