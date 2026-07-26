//! The client entry point.

use std::env;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use url::Url;

use crate::config::ClientOptions;
use crate::error::Error;
use crate::http::{Http, Limits};
use crate::sandboxes::Sandboxes;
use crate::templates::Templates;

const DEFAULT_BASE_URL: &str = "https://api.example.com";

#[derive(Clone, Debug)]
pub(crate) struct AgentTarget {
    pub(crate) port: u16,
    pub(crate) base_override: Option<Url>,
}

/// Client for the fissionplane API.
///
/// Cheap to clone; clones share the underlying connection pool.
///
/// # Examples
///
/// ```no_run
/// use fissionplane::{ClientOptions, FissionPlane};
///
/// # async fn demo() -> Result<(), fissionplane::Error> {
/// let client = FissionPlane::new(ClientOptions::new())?;
/// let page = client.sandboxes().list(Default::default()).await?;
/// println!("{} sandboxes on the first page", page.items.len());
/// # Ok(())
/// # }
/// ```
#[derive(Clone, Debug)]
pub struct FissionPlane {
    http: Arc<Http>,
    agent: AgentTarget,
}

impl FissionPlane {
    /// Creates a client from explicit options and environment defaults.
    ///
    /// `FISSIONPLANE_API_KEY` supplies a missing API key, and
    /// `FISSIONPLANE_API_URL` supplies a missing control-plane URL.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Config`] if no credential is available or a
    /// configured URL, credential, or user agent is invalid. Returns
    /// [`Error::Http`] if the HTTP client cannot be constructed.
    pub fn new(options: ClientOptions) -> Result<Self, Error> {
        let base_url = options
            .base_url
            .or_else(|| env::var("FISSIONPLANE_API_URL").ok())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned());
        let base = Url::parse(&base_url)
            .map_err(|source| Error::Config(format!("base URL {base_url:?}: {source}")))?;

        let (header, secret, origin) = match (options.api_key, options.access_token) {
            (Some(key), _) => ("X-API-Key", key, "the API key"),
            (None, Some(token)) => ("Authorization", token, "the access token"),
            (None, None) => match env::var("FISSIONPLANE_API_KEY").ok() {
                Some(key) => ("X-API-Key", key, "FISSIONPLANE_API_KEY"),
                None => {
                    return Err(Error::Config(
                        "no credential: pass api_key/access_token or set FISSIONPLANE_API_KEY"
                            .to_owned(),
                    ));
                },
            },
        };
        // Validated before the bearer scheme is prepended, so the check
        // sees the caller's value rather than the SDK's prefix.
        validate_credential(&secret, origin)?;
        let credential = match header {
            "Authorization" => format!("Bearer {secret}"),
            _ => secret,
        };

        let mut headers = HeaderMap::new();
        if let Some(user_agent) = &options.user_agent {
            let value = HeaderValue::from_str(user_agent)
                .map_err(|source| Error::Config(format!("user agent {user_agent:?}: {source}")))?;
            headers.insert(USER_AGENT, value);
        }
        let mut value = HeaderValue::from_str(&credential).map_err(|source| {
            Error::Config(format!("credential is not a header value: {source}"))
        })?;
        value.set_sensitive(true);
        headers.insert(header, value);

        // Zero means "no deadline", so it must not reach reqwest, which
        // would treat it as "expire immediately".
        let request_timeout =
            (options.request_timeout != Duration::ZERO).then_some(options.request_timeout);
        let mut builder = reqwest::Client::builder();
        if let Some(timeout) = request_timeout {
            builder = builder.timeout(timeout);
        }
        let client = builder.build()?;
        let limits = Limits {
            max_retries: options.max_retries,
            request_timeout,
        };
        Ok(Self {
            http: Arc::new(Http::new(client, base, headers, limits)),
            agent: AgentTarget {
                port: options.agent_port,
                base_override: options.agent_base_url_override,
            },
        })
    }

    /// Operations on the sandbox collection.
    ///
    /// Returns a cheaply constructed handle that shares this client's
    /// connection pool and credentials.
    pub fn sandboxes(&self) -> Sandboxes {
        Sandboxes::new(Arc::clone(&self.http), self.agent.clone())
    }

    /// The template registry and template builds.
    ///
    /// Returns a cheaply constructed handle that shares this client's
    /// connection pool and credentials.
    pub fn templates(&self) -> Templates {
        Templates::new(Arc::clone(&self.http))
    }
}

/// Rejects a credential that cannot be what the caller meant.
///
/// The format itself belongs to the installation, so this deliberately
/// does not guess at one; it catches the two mistakes that otherwise
/// surface as an unexplained 401: an empty value from an unset
/// environment variable, and one that carried surrounding whitespace or
/// a trailing newline out of a shell or secret store.
fn validate_credential(secret: &str, origin: &str) -> Result<(), Error> {
    if secret.is_empty() {
        return Err(Error::Config(format!(
            "{origin} is empty: pass a credential to ClientOptions::api_key or \
             ClientOptions::access_token, or set FISSIONPLANE_API_KEY"
        )));
    }
    if secret.chars().any(char::is_whitespace) {
        return Err(Error::Config(format!(
            "{origin} contains whitespace: pass the credential verbatim to \
             ClientOptions::api_key or ClientOptions::access_token, or set \
             FISSIONPLANE_API_KEY without surrounding quotes or a trailing newline"
        )));
    }
    Ok(())
}
