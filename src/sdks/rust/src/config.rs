//! Client configuration.

use std::fmt;
use std::time::Duration;

use url::Url;

/// Default port for a sandbox's data-plane agent.
pub const DEFAULT_AGENT_PORT: u16 = 50_000;

/// Default deadline for a single HTTP request.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Default number of automatic retries after a first failed attempt.
pub const DEFAULT_MAX_RETRIES: u32 = 2;

/// Configuration for [`crate::FissionPlane::new`].
///
/// Unset fields are resolved when the client is built:
///
/// | Field | Environment variable | Default |
/// |---|---|---|
/// | `api_key` | `FISSIONPLANE_API_KEY` | — (a credential is required) |
/// | `base_url` | `FISSIONPLANE_API_URL` | the contract's server URL |
/// | `agent_port` | — | [`DEFAULT_AGENT_PORT`] |
/// | `request_timeout` | — | [`DEFAULT_REQUEST_TIMEOUT`] |
/// | `max_retries` | — | [`DEFAULT_MAX_RETRIES`] |
/// | `user_agent` | — | `fissionplane-rust/<version>` |
///
/// # Examples
///
/// ```no_run
/// use fissionplane::{ClientOptions, FissionPlane};
///
/// # fn demo() -> Result<(), fissionplane::Error> {
/// let client = FissionPlane::new(
///     ClientOptions::new()
///         .api_key("sk-example")
///         .base_url("https://api.example.com"),
/// )?;
/// # let _ = client;
/// # Ok(())
/// # }
/// ```
#[derive(Clone)]
pub struct ClientOptions {
    pub(crate) api_key: Option<String>,
    pub(crate) access_token: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) agent_port: u16,
    pub(crate) agent_base_url_override: Option<Url>,
    pub(crate) request_timeout: Duration,
    pub(crate) max_retries: u32,
    pub(crate) user_agent: Option<String>,
}

impl Default for ClientOptions {
    fn default() -> Self {
        Self {
            api_key: None,
            access_token: None,
            base_url: None,
            agent_port: DEFAULT_AGENT_PORT,
            agent_base_url_override: None,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            max_retries: DEFAULT_MAX_RETRIES,
            user_agent: None,
        }
    }
}

impl ClientOptions {
    /// Options with every field at its default.
    ///
    /// The returned value reads credentials and URLs from the
    /// environment only when passed to [`crate::FissionPlane::new`].
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the organisation API key sent as `X-API-Key`.
    ///
    /// Returns the updated options. If omitted, the client reads
    /// `FISSIONPLANE_API_KEY`.
    pub fn api_key(mut self, api_key: impl Into<String>) -> Self {
        self.api_key = Some(api_key.into());
        self
    }

    /// Sets the OIDC bearer token sent as `Authorization: Bearer`.
    ///
    /// Returns the updated options. An explicitly configured API key
    /// takes precedence over this token.
    pub fn access_token(mut self, access_token: impl Into<String>) -> Self {
        self.access_token = Some(access_token.into());
        self
    }

    /// Sets the control-plane base URL.
    ///
    /// Returns the updated options. If omitted, the client reads
    /// `FISSIONPLANE_API_URL` and then uses the service default.
    pub fn base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Sets the data-plane agent port.
    ///
    /// Returns the updated options. The default is
    /// [`DEFAULT_AGENT_PORT`].
    pub fn agent_port(mut self, agent_port: u16) -> Self {
        self.agent_port = agent_port;
        self
    }

    /// Overrides the derived data-plane URL for every sandbox.
    ///
    /// Returns the updated options. This is intended for tests and
    /// single-sandbox proxies.
    pub fn agent_base_url_override(mut self, base_url: Url) -> Self {
        self.agent_base_url_override = Some(base_url);
        self
    }

    /// Sets the deadline for one HTTP request, on either plane.
    ///
    /// The deadline covers the whole request, including reading the
    /// response body, and applies to every attempt separately. Returns
    /// the updated options. The default is
    /// [`DEFAULT_REQUEST_TIMEOUT`]; [`Duration::ZERO`] disables the
    /// deadline, leaving a slow call to run until the peer or the
    /// operating system ends it.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use std::time::Duration;
    ///
    /// use fissionplane::{ClientOptions, FissionPlane};
    ///
    /// # fn demo() -> Result<(), fissionplane::Error> {
    /// let quick = FissionPlane::new(
    ///     ClientOptions::new().request_timeout(Duration::from_secs(5)),
    /// )?;
    /// let patient = FissionPlane::new(
    ///     ClientOptions::new().request_timeout(Duration::ZERO),
    /// )?;
    /// # let _ = (quick, patient);
    /// # Ok(())
    /// # }
    /// ```
    pub fn request_timeout(mut self, request_timeout: Duration) -> Self {
        self.request_timeout = request_timeout;
        self
    }

    /// Sets how many times a failed request may be replayed.
    ///
    /// A retry happens only when the failure is worth repeating (a
    /// connect or timeout failure, a 429, a 5xx, or an error document
    /// whose `retryable` is true) and the request is safe to repeat: a
    /// read, or a write carrying an idempotency key. Returns the
    /// updated options. The default is [`DEFAULT_MAX_RETRIES`]; `0`
    /// disables retries.
    pub fn max_retries(mut self, max_retries: u32) -> Self {
        self.max_retries = max_retries;
        self
    }

    /// Overrides the `User-Agent` sent on every request.
    ///
    /// Returns the updated options. The default identifies the SDK and
    /// its version, `fissionplane-rust/<version>`; set this to identify
    /// your own application instead.
    pub fn user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = Some(user_agent.into());
        self
    }
}

impl fmt::Debug for ClientOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClientOptions")
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field(
                "access_token",
                &self.access_token.as_ref().map(|_| "<redacted>"),
            )
            .field("base_url", &self.base_url)
            .field("agent_port", &self.agent_port)
            .field("agent_base_url_override", &self.agent_base_url_override)
            .field("request_timeout", &self.request_timeout)
            .field("max_retries", &self.max_retries)
            .field("user_agent", &self.user_agent)
            .finish()
    }
}
