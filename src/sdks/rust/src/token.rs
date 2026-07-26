//! The refreshable data-plane credential.

use std::fmt;
use std::sync::{Arc, RwLock};

use reqwest::Method;
use tracing::debug;

use crate::error::Error;
use crate::http::Http;
use crate::models::{CapabilityToken, MintTokenRequest};

/// A capability token that can re-mint itself through the control
/// plane.
///
/// Shared by a [`crate::Sandbox`] handle and every data-plane module
/// built from it, so one refresh re-arms all of them — including
/// modules built before a resume moved the sandbox's epoch.
#[derive(Clone)]
pub(crate) struct TokenSource {
    control: Arc<Http>,
    sandbox_id: String,
    current: Arc<RwLock<CapabilityToken>>,
}

impl TokenSource {
    pub(crate) fn new(control: Arc<Http>, sandbox_id: String, token: CapabilityToken) -> Self {
        Self {
            control,
            sandbox_id,
            current: Arc::new(RwLock::new(token)),
        }
    }

    /// The token a data-plane request should carry right now.
    pub(crate) fn current(&self) -> CapabilityToken {
        match self.current.read() {
            Ok(token) => token.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// Publishes a token minted elsewhere, re-arming modules built
    /// earlier from the same sandbox handle.
    pub(crate) fn replace(&self, token: CapabilityToken) {
        match self.current.write() {
            Ok(mut slot) => *slot = token,
            Err(poisoned) => *poisoned.into_inner() = token,
        }
    }

    /// Mints a token for the sandbox's current epoch.
    ///
    /// The port scope of the token being replaced is carried over: a
    /// refresh must never widen an attenuated credential into a full
    /// one behind the caller's back.
    pub(crate) async fn refresh(&self) -> Result<CapabilityToken, Error> {
        let ports = self.current().ports;
        debug!(
            sandbox_id = %self.sandbox_id,
            scoped = ports.is_some(),
            "re-minting the sandbox capability token",
        );
        let builder = self
            .control
            .request(
                Method::POST,
                &format!("/v1/sandboxes/{}/token", self.sandbox_id),
            )
            .json(&MintTokenRequest {
                ttl_seconds: None,
                ports,
            });
        let token: CapabilityToken = self.control.send_json(builder).await?;
        self.replace(token.clone());
        Ok(token)
    }
}

impl fmt::Debug for TokenSource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TokenSource")
            .field("sandbox_id", &self.sandbox_id)
            .field("token", &"<redacted>")
            .finish()
    }
}
