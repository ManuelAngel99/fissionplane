//! Shared WebSocket transport for data-plane streams.

use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::{SinkExt, Stream};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::protocol::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};
use url::Url;

use crate::Error;

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Opens a data-plane stream.
///
/// `timeout` bounds the handshake only; once the socket is open, the
/// stream stays open until either side closes it.
pub(crate) async fn connect(
    mut url: Url,
    token: &str,
    query: &[(&str, String)],
    timeout: Option<Duration>,
) -> Result<EventSocket, Error> {
    let scheme = match url.scheme() {
        "http" => "ws",
        "https" => "wss",
        "ws" => "ws",
        "wss" => "wss",
        other => {
            return Err(Error::Config(format!(
                "data-plane URL has unsupported scheme {other:?}"
            )));
        },
    };
    url.set_scheme(scheme)
        .map_err(|()| Error::Config("could not set WebSocket URL scheme".to_owned()))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }

    let protocols = format!(
        "fissionplane.v1, fissionplane.token.{}",
        base64_url(token.as_bytes())
    );
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|source| Error::Protocol(format!("invalid WebSocket request: {source}")))?;
    request.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_str(&protocols)
            .map_err(|source| Error::Protocol(format!("invalid subprotocol header: {source}")))?,
    );

    let (socket, response) = match timeout {
        Some(limit) => tokio::time::timeout(limit, connect_async(request))
            .await
            .map_err(|_elapsed| Error::WaitTimeout)??,
        None => connect_async(request).await?,
    };
    let selected = response
        .headers()
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok());
    if selected != Some("fissionplane.v1") {
        return Err(Error::Protocol(
            "server did not select fissionplane.v1".to_owned(),
        ));
    }
    Ok(EventSocket { socket })
}

#[derive(Debug)]
pub(crate) struct EventSocket {
    socket: Socket,
}

impl EventSocket {
    pub(crate) async fn send<T: Serialize>(&mut self, message: &T) -> Result<(), Error> {
        let text = serde_json::to_string(message).map_err(|source| {
            Error::Protocol(format!("could not encode stream frame: {source}"))
        })?;
        self.socket.send(Message::Text(text.into())).await?;
        Ok(())
    }

    pub(crate) async fn close(&mut self) -> Result<(), Error> {
        self.socket.close(None).await?;
        Ok(())
    }

    pub(crate) fn poll_event<T: DeserializeOwned>(
        &mut self,
        cx: &mut Context<'_>,
        known_types: &[&str],
        stream_name: &str,
        validate: fn(&T) -> bool,
    ) -> Poll<Option<Result<T, Error>>> {
        loop {
            let frame = match Pin::new(&mut self.socket).poll_next(cx) {
                Poll::Ready(Some(Ok(frame))) => frame,
                Poll::Ready(Some(Err(error))) => {
                    return Poll::Ready(Some(Err(Error::WebSocket(error))));
                },
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            };
            let Message::Text(text) = frame else {
                match frame {
                    Message::Ping(_) | Message::Pong(_) => continue,
                    Message::Close(_) => return Poll::Ready(None),
                    _ => {
                        return Poll::Ready(Some(Err(Error::Protocol(format!(
                            "{stream_name} expected a JSON text frame"
                        )))));
                    },
                }
            };
            match parse_event_text(text.as_str(), known_types, stream_name, validate) {
                Ok(Some(event)) => return Poll::Ready(Some(Ok(event))),
                Ok(None) => continue,
                Err(error) => return Poll::Ready(Some(Err(error))),
            }
        }
    }
}

fn parse_event_text<T: DeserializeOwned>(
    text: &str,
    known_types: &[&str],
    stream_name: &str,
    validate: fn(&T) -> bool,
) -> Result<Option<T>, Error> {
    let value: Value = serde_json::from_str(text).map_err(|source| {
        Error::Protocol(format!("{stream_name} received malformed JSON: {source}"))
    })?;
    let Some(message_type) = value.get("type").and_then(Value::as_str) else {
        return Err(Error::Protocol(format!(
            "{stream_name} frame type must be a string"
        )));
    };
    if !known_types.contains(&message_type) {
        return Ok(None);
    }
    let event = serde_json::from_value(value).map_err(|source| {
        Error::Protocol(format!("malformed known {stream_name} frame: {source}"))
    })?;
    if !validate(&event) {
        return Err(Error::Protocol(format!(
            "malformed known {stream_name} frame"
        )));
    }
    Ok(Some(event))
}

fn base64_url(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut encoded = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied();
        let third = chunk.get(2).copied();
        encoded.push(char::from(ALPHABET[usize::from(first >> 2)]));
        encoded.push(char::from(
            ALPHABET[usize::from(((first & 0x03) << 4) | second.unwrap_or(0) >> 4)],
        ));
        if let Some(second) = second {
            encoded.push(char::from(
                ALPHABET[usize::from(((second & 0x0f) << 2) | third.unwrap_or(0) >> 6)],
            ));
        }
        if let Some(third) = third {
            encoded.push(char::from(ALPHABET[usize::from(third & 0x3f)]));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{FileWatchEvent, ProcessStreamEvent};

    #[test]
    fn token_encoding_is_unpadded_base64url() {
        assert_eq!(base64_url(b"tok1"), "dG9rMQ");
        assert_eq!(base64_url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn parser_ignores_unknown_types_and_decodes_known_types() {
        let unknown = parse_event_text::<ProcessStreamEvent>(
            r#"{"type":"future","value":1}"#,
            &["stdout", "stderr", "exit", "gap"],
            "process stream",
            |_| true,
        );
        assert!(matches!(unknown, Ok(None)));

        let event = parse_event_text::<ProcessStreamEvent>(
            r#"{"type":"stdout","sequence":1,"data":"hello"}"#,
            &["stdout", "stderr", "exit", "gap"],
            "process stream",
            |_| true,
        );
        assert!(matches!(
            event,
            Ok(Some(ProcessStreamEvent::Stdout {
                sequence: 1,
                ref data
            })) if data == "hello"
        ));
    }

    #[test]
    fn parser_rejects_malformed_known_frames() {
        let result = parse_event_text::<ProcessStreamEvent>(
            r#"{"type":"exit","sequence":1}"#,
            &["stdout", "stderr", "exit", "gap"],
            "process stream",
            |_| true,
        );
        assert!(matches!(result, Err(Error::Protocol(_))));

        let watch = parse_event_text::<FileWatchEvent>(
            r#"{"type":"moved","sequence":2,"path":"/new","kind":"file"}"#,
            &["created", "modified", "moved", "removed", "overflow"],
            "file watch",
            |_| true,
        );
        assert!(matches!(watch, Err(Error::Protocol(_))));
    }
}
