//! Shared transport for a sandbox's data plane.
//!
//! Every data-plane call carries a capability token bound to the
//! sandbox's epoch, and both can move underneath a long-lived handle:
//! the token expires, or a resume advances the epoch. Rather than
//! failing closed and making the caller rebuild the handle, each request
//! here re-mints once through the control plane when the agent answers
//! 401 and then replays the call with the fresh token.

use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::{Method, Response};
use serde::de::DeserializeOwned;
use tokio_tungstenite::tungstenite;
use url::Url;

use crate::client::AgentTarget;
use crate::error::Error;
use crate::http::Http;
use crate::models;
use crate::streaming::{self, EventSocket};
use crate::token::TokenSource;

/// The header carrying a capability token on the data plane.
const TOKEN_HEADER: &str = "X-Sandbox-Token";

/// The agent's base URL for one sandbox, plus its refreshable
/// credential.
#[derive(Clone, Debug)]
pub(crate) struct DataPlane {
    http: Http,
    base: Url,
    credential: TokenSource,
}

impl DataPlane {
    pub(crate) fn new(
        http: &Http,
        agent: &AgentTarget,
        info: &models::Sandbox,
        credential: TokenSource,
    ) -> Result<Self, Error> {
        let base = agent_base_url(agent, info)?;
        Ok(Self {
            // The token is attached per request instead of baked into
            // the default headers, so a refresh takes effect at once.
            http: http.with_target(base.clone(), HeaderMap::new()),
            base,
            credential,
        })
    }

    /// The agent's base URL, for building stream URLs.
    pub(crate) fn base(&self) -> &Url {
        &self.base
    }

    pub(crate) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        self.http.request(method, path)
    }

    pub(crate) async fn send_json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, Error> {
        let response = self.execute(request).await?;
        Ok(response.json().await?)
    }

    pub(crate) async fn send_no_content(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<(), Error> {
        self.execute(request).await?;
        Ok(())
    }

    pub(crate) async fn send_bytes(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<Vec<u8>, Error> {
        let response = self.execute(request).await?;
        Ok(response.bytes().await?.to_vec())
    }

    /// Sends the request with the current token, re-minting once and
    /// replaying it if the agent rejects the token.
    async fn execute(&self, request: reqwest::RequestBuilder) -> Result<Response, Error> {
        let replay = request.try_clone();
        let token = self.credential.current();
        let first = self.http.execute(authorized(request, &token.token)?).await;
        match (first, replay) {
            (Err(rejected), Some(replay)) if is_unauthorized(&rejected) => {
                let token = self.credential.refresh().await?;
                self.http.execute(authorized(replay, &token.token)?).await
            },
            (outcome, _) => outcome,
        }
    }

    /// Opens a data-plane stream, re-minting once and reconnecting if
    /// the handshake is rejected for the token.
    pub(crate) async fn connect(
        &self,
        url: Url,
        query: &[(&str, String)],
    ) -> Result<EventSocket, Error> {
        let timeout = self.http.limits().request_timeout;
        let token = self.credential.current();
        match streaming::connect(url.clone(), &token.token, query, timeout).await {
            Err(rejected) if is_unauthorized_handshake(&rejected) => {
                let token = self.credential.refresh().await?;
                streaming::connect(url, &token.token, query, timeout).await
            },
            outcome => outcome,
        }
    }
}

/// The agent's base URL: the override when configured, otherwise the
/// agent port's own hostname.
pub(crate) fn agent_base_url(agent: &AgentTarget, info: &models::Sandbox) -> Result<Url, Error> {
    if let Some(base) = &agent.base_override {
        return Ok(base.clone());
    }
    let url = format!("https://{}-{}.{}", agent.port, info.sandbox_id, info.domain);
    Url::parse(&url).map_err(|source| Error::Config(format!("data-plane URL {url:?}: {source}")))
}

fn authorized(
    request: reqwest::RequestBuilder,
    token: &str,
) -> Result<reqwest::RequestBuilder, Error> {
    let mut value = HeaderValue::from_str(token)
        .map_err(|source| Error::Config(format!("token is not a header value: {source}")))?;
    value.set_sensitive(true);
    Ok(request.header(TOKEN_HEADER, value))
}

fn is_unauthorized(error: &Error) -> bool {
    matches!(error, Error::Api { status: 401, .. })
}

fn is_unauthorized_handshake(error: &Error) -> bool {
    matches!(
        error,
        Error::WebSocket(tungstenite::Error::Http(response)) if response.status() == 401
    )
}
