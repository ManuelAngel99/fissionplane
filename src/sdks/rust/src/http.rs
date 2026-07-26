//! Shared HTTP transport: default headers, error mapping, and the
//! bounded retry loop every request goes through.

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use reqwest::{Method, Request, Response};
use serde::de::DeserializeOwned;
use tracing::debug;

use crate::error::{self, Error};
use crate::models::ApiError;
use crate::retry;

/// The `User-Agent` every request carries unless the caller set one.
pub(crate) const DEFAULT_USER_AGENT: &str =
    concat!("fissionplane-rust/", env!("CARGO_PKG_VERSION"));

/// The header the contract documents for de-duplicating a write.
pub(crate) const IDEMPOTENCY_KEY: &str = "Idempotency-Key";

/// Transport tunables resolved from [`crate::ClientOptions`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// Attempts after the first, per request. Zero disables retries.
    pub(crate) max_retries: u32,
    /// Deadline for one attempt, or `None` when the caller disabled it.
    pub(crate) request_timeout: Option<Duration>,
}

#[derive(Clone, Debug)]
pub(crate) struct Http {
    client: reqwest::Client,
    base: url::Url,
    headers: HeaderMap,
    limits: Limits,
}

impl Http {
    pub(crate) fn new(
        client: reqwest::Client,
        base: url::Url,
        mut headers: HeaderMap,
        limits: Limits,
    ) -> Self {
        // A caller's own `User-Agent` is already in `headers` and wins.
        headers
            .entry(USER_AGENT)
            .or_insert(HeaderValue::from_static(DEFAULT_USER_AGENT));
        Self {
            client,
            base,
            headers,
            limits,
        }
    }

    pub(crate) fn with_target(&self, base: url::Url, mut headers: HeaderMap) -> Self {
        // Carry the resolved `User-Agent` onto the new target so an
        // override identifies the caller on both planes.
        if let Some(user_agent) = self.headers.get(USER_AGENT) {
            headers.entry(USER_AGENT).or_insert(user_agent.clone());
        }
        Self {
            client: self.client.clone(),
            base,
            headers,
            limits: self.limits,
        }
    }

    pub(crate) fn limits(&self) -> Limits {
        self.limits
    }

    pub(crate) fn request(&self, method: Method, path: &str) -> reqwest::RequestBuilder {
        // Url normalizes an empty path to "/", which would otherwise
        // produce a double slash before API paths.
        let url = format!("{}{}", self.base.as_str().trim_end_matches('/'), path);
        self.client
            .request(method, url)
            .headers(self.headers.clone())
    }

    /// Sends the request, replaying it while the failure is worth
    /// repeating and the request is safe to repeat.
    ///
    /// Retries are bounded by [`Limits::max_retries`] and spaced by
    /// [`retry::backoff`]. A request whose body cannot be cloned is
    /// sent exactly once.
    pub(crate) async fn execute(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<Response, Error> {
        let mut pending = request.build()?;
        let retries = if is_idempotent(&pending) {
            self.limits.max_retries
        } else {
            0
        };
        let mut attempt: u32 = 0;
        loop {
            let spare = if attempt < retries {
                pending.try_clone()
            } else {
                None
            };
            let failure = match self.client.execute(pending).await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => Failure::from_response(response).await,
                Err(source) => Failure::from_transport(source),
            };
            let Some(next) = spare.filter(|_| failure.retryable) else {
                return Err(failure.error);
            };
            let backoff = retry::backoff(attempt);
            debug!(
                method = %next.method(),
                path = next.url().path(),
                attempt = attempt + 1,
                retries,
                ?backoff,
                error = %failure.error,
                "replaying a failed request",
            );
            tokio::time::sleep(backoff).await;
            pending = next;
            attempt += 1;
        }
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
}

/// A failed attempt: what the caller sees, and whether replaying it
/// could plausibly do better.
struct Failure {
    error: Error,
    retryable: bool,
}

impl Failure {
    async fn from_response(response: Response) -> Self {
        let status = response.status();
        // The header is a fallback: the body's own `request_id` wins when
        // both are present.
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response.bytes().await.unwrap_or_default();
        match serde_json::from_slice::<ApiError>(&body) {
            Ok(parsed) => {
                let stated = parsed.retryable;
                Self {
                    error: Error::from_api_error(status.as_u16(), parsed, request_id),
                    // An explicit `retryable: false` is the server
                    // telling us not to, even on a 5xx.
                    retryable: stated.unwrap_or_else(|| error::retryable_status(status.as_u16())),
                }
            },
            Err(_) => Self {
                error: Error::from_status(status, &body, request_id),
                retryable: error::retryable_status(status.as_u16()),
            },
        }
    }

    fn from_transport(source: reqwest::Error) -> Self {
        // A connect or timeout failure may never have reached the
        // server; anything else (a body that would not decode, a bad
        // URL) will fail the same way again.
        let retryable = source.is_connect() || source.is_timeout();
        Self {
            error: Error::Http(source),
            retryable,
        }
    }
}

/// Whether replaying the request cannot produce a second effect: a
/// read, or a write the server de-duplicates by idempotency key.
fn is_idempotent(request: &Request) -> bool {
    matches!(request.method().as_str(), "GET" | "HEAD")
        || request.headers().contains_key(IDEMPOTENCY_KEY)
}
