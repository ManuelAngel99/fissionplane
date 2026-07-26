//! Published-port exposure records.

use std::sync::Arc;

use reqwest::Method;

use crate::error::Error;
use crate::http::Http;
use crate::models::{ExposePortRequest, PortExposure, PortList, PortVisibility};

/// Port exposure records for one sandbox. Obtained from
/// [`crate::Sandbox::ports`].
///
/// Every port defaults to private (capability token required); public
/// exposure is an explicit, durable, audited opt-in. The server rejects
/// exposure records for its reserved agent port.
#[derive(Clone, Debug)]
pub struct Ports {
    http: Arc<Http>,
    sandbox_id: String,
}

impl Ports {
    pub(crate) fn new(http: Arc<Http>, sandbox_id: String) -> Self {
        Self { http, sandbox_id }
    }

    fn path(&self, suffix: &str) -> String {
        format!("/v1/sandboxes/{}/ports{suffix}", self.sandbox_id)
    }

    fn port_path(&self, port: u16) -> String {
        format!("/v1/sandboxes/{}/ports/{port}", self.sandbox_id)
    }

    /// The sandbox's exposure records. A port with no record is
    /// private.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the request is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn list(&self) -> Result<PortList, Error> {
        let request = self.http.request(Method::GET, &self.path(""));
        self.http.send_json(request).await
    }

    /// Record the port's exposure. Idempotent: repeating re-asserts
    /// the record.
    ///
    /// [`PortVisibility::Public`] admits anonymous traffic to this tenant
    /// application port; [`PortVisibility::Private`] records it without
    /// widening access.
    ///
    /// Returns the resulting exposure record.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the exposure is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn expose(
        &self,
        port: u16,
        visibility: PortVisibility,
    ) -> Result<PortExposure, Error> {
        let request = self
            .http
            .request(Method::PUT, &self.port_path(port))
            .json(&ExposePortRequest { visibility });
        self.http.send_json(request).await
    }

    /// Remove the port's exposure record, returning it to the
    /// default: private, capability token required. Public traffic to
    /// the port stops.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the record cannot be removed or
    /// [`Error::Http`] if transport fails.
    pub async fn unexpose(&self, port: u16) -> Result<(), Error> {
        let request = self.http.request(Method::DELETE, &self.port_path(port));
        self.http.send_no_content(request).await
    }
}
