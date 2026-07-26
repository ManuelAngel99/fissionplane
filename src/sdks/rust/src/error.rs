//! The one error type every SDK operation returns.

use reqwest::StatusCode;

use crate::models::ApiError;

/// Everything a call through this SDK can fail with.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The request never produced a response document: connection,
    /// TLS, timeout, or a 2xx body that failed to decode.
    #[error("http transport error: {0}")]
    Http(#[from] reqwest::Error),

    /// A WebSocket handshake or connection failed.
    #[error("websocket transport error: {0}")]
    WebSocket(#[from] tokio_tungstenite::tungstenite::Error),

    /// A known streaming frame did not match the data-plane protocol.
    #[error("streaming protocol error: {0}")]
    Protocol(String),

    /// A non-2xx response from the control plane or the data plane.
    ///
    /// Both planes share one wire schema ([`ApiError`]); this variant
    /// carries it flattened, plus the HTTP status. `code` is the
    /// machine-readable cause (`name_taken`, `lifecycle_conflict`,
    /// `rate_limited`, ...) and is `None` only when the body was not a
    /// contract error document.
    #[error("api error {status}: {message}")]
    Api {
        /// The HTTP status (401, 403, 404, 408, 409, 410, 429, ...).
        status: u16,
        /// Machine-readable cause from the error body.
        code: Option<String>,
        /// Human-readable detail from the error body.
        message: String,
        /// Whether issuing the same request again would plausibly work.
        retryable: bool,
        /// The `request_id` for correlating with support and audit.
        request_id: Option<String>,
    },

    /// The sandbox handle carries no capability token. Handles from
    /// `create` and `resume` carry one; a handle from `get` or `list`
    /// does not until you mint a token.
    #[error("sandbox handle has no capability token; resume the sandbox or mint one")]
    MissingToken,

    /// A template build reached the terminal `failed` status.
    #[error("template build failed: {error}")]
    BuildFailed {
        /// The build's `error` field: what failed.
        error: String,
    },

    /// An operation gave up because its own timeout elapsed: a poll
    /// loop that never reached a terminal state, or a WebSocket
    /// handshake that did not complete inside the configured request
    /// timeout.
    #[error("timed out waiting for a terminal state")]
    WaitTimeout,

    /// The client could not be configured: no credential, no base URL,
    /// or a value that does not parse.
    #[error("invalid configuration: {0}")]
    Config(String),
}

impl Error {
    /// Maps a non-2xx response whose body is not a contract error
    /// document: a proxy's HTML page, an empty body, or a truncated one.
    pub(crate) fn from_status(
        status: StatusCode,
        body: &[u8],
        header_request_id: Option<String>,
    ) -> Self {
        Self::Api {
            status: status.as_u16(),
            code: None,
            message: non_document_message(status, body),
            retryable: default_retryable(status.as_u16()),
            request_id: header_request_id,
        }
    }

    pub(crate) fn from_api_error(
        status: u16,
        body: ApiError,
        header_request_id: Option<String>,
    ) -> Self {
        Self::Api {
            status,
            code: Some(body.code),
            message: body.message,
            retryable: body.retryable.unwrap_or_else(|| default_retryable(status)),
            request_id: body.request_id.or(header_request_id),
        }
    }
}

/// What [`Error::Api::retryable`] reports when the error document does
/// not say: only the two statuses that mean "come back later".
fn default_retryable(status: u16) -> bool {
    matches!(status, 429 | 503)
}

/// Whether the SDK replays an idempotent request whose error document
/// did not state `retryable`.
///
/// Wider than [`default_retryable`] on purpose: a bare 500 with no
/// contract body is exactly the case an automatic retry exists for, but
/// it is not a promise to the caller that repeating will work, so the
/// surfaced flag stays conservative.
pub(crate) fn retryable_status(status: u16) -> bool {
    status == 429 || (500..=599).contains(&status)
}

fn non_document_message(status: StatusCode, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    let text = text.trim();
    if text.is_empty() {
        status
            .canonical_reason()
            .unwrap_or("unexpected status")
            .to_owned()
    } else {
        text.to_owned()
    }
}
