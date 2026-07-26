//! The template registry and template builds.

use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;

use crate::error::Error;
use crate::http::Http;
use crate::models::{
    CreateTemplateBuildRequest, Template, TemplateBuild, TemplateBuildLogs, TemplateBuildStatus,
    TemplateList,
};

/// The template registry. Obtained from
/// [`crate::FissionPlane::templates`].
#[derive(Clone, Debug)]
pub struct Templates {
    http: Arc<Http>,
}

impl Templates {
    pub(crate) fn new(http: Arc<Http>) -> Self {
        Self { http }
    }

    /// One page of the templates visible to the organisation. Pass
    /// the page's `next_cursor` back as `cursor` for the next page.
    ///
    /// `limit` controls the page size and `cursor` selects the starting
    /// position.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the request is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn list(
        &self,
        limit: Option<u32>,
        cursor: Option<&str>,
    ) -> Result<TemplateList, Error> {
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(limit) = limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(cursor) = cursor {
            query.push(("cursor", cursor.to_owned()));
        }
        let request = self
            .http
            .request(Method::GET, "/v1/templates")
            .query(&query);
        self.http.send_json(request).await
    }

    /// Resolve a template alias or ID to its current record.
    ///
    /// Aliases are mutable; the artifact a sandbox is created from is
    /// resolved at admission time, so reading a template and creating
    /// from it can observe different artifacts if the alias is
    /// re-pointed in between.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the template is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn get(&self, template: &str) -> Result<Template, Error> {
        let request = self
            .http
            .request(Method::GET, &format!("/v1/templates/{template}"));
        self.http.send_json(request).await
    }

    /// Retire the template record and its alias. Existing sandboxes
    /// created from the artifact are unaffected.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if deletion is rejected or
    /// [`Error::Http`] if transport fails.
    pub async fn delete(&self, template: &str) -> Result<(), Error> {
        let request = self
            .http
            .request(Method::DELETE, &format!("/v1/templates/{template}"));
        self.http.send_no_content(request).await
    }

    /// Start a template build from an OCI image reference and a
    /// recipe. The build is asynchronous: use the returned handle to
    /// poll it, tail its logs, or [`TemplateBuildHandle::wait`] for a
    /// terminal state.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use fissionplane::WaitOptions;
    /// use fissionplane::models::CreateTemplateBuildRequest;
    ///
    /// # async fn demo(client: fissionplane::FissionPlane) -> Result<(), fissionplane::Error> {
    /// let mut build = client
    ///     .templates()
    ///     .build(CreateTemplateBuildRequest {
    ///         image: "docker.io/library/python:3.13".to_owned(),
    ///         alias: Some("python".to_owned()),
    ///         ..Default::default()
    ///     })
    ///     .await?;
    /// let done = build.wait(WaitOptions::default()).await?;
    /// println!("artifact: {:?}", done.artifact_id);
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the build is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn build(
        &self,
        request: CreateTemplateBuildRequest,
    ) -> Result<TemplateBuildHandle, Error> {
        let builder = self
            .http
            .request(Method::POST, "/v1/templates/builds")
            .json(&request);
        let info: TemplateBuild = self.http.send_json(builder).await?;
        Ok(TemplateBuildHandle {
            http: Arc::clone(&self.http),
            info,
        })
    }

    /// Fetch an existing build by identifier.
    ///
    /// Returns a handle containing the current build representation.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the build is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn get_build(&self, build_id: &str) -> Result<TemplateBuildHandle, Error> {
        let request = self
            .http
            .request(Method::GET, &format!("/v1/templates/builds/{build_id}"));
        let info: TemplateBuild = self.http.send_json(request).await?;
        Ok(TemplateBuildHandle {
            http: Arc::clone(&self.http),
            info,
        })
    }
}

/// How [`TemplateBuildHandle::wait`] polls.
#[derive(Clone, Copy, Debug)]
pub struct WaitOptions {
    /// Pause between polls. Default: 2 seconds.
    pub poll_interval: Duration,
    /// Give up with [`Error::WaitTimeout`] after this long. Default:
    /// no timeout — builds are bounded server-side.
    pub timeout: Option<Duration>,
}

impl Default for WaitOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(2),
            timeout: None,
        }
    }
}

/// A live handle on one template build.
#[derive(Clone, Debug)]
pub struct TemplateBuildHandle {
    http: Arc<Http>,
    /// Last representation fetched; refreshed by
    /// [`TemplateBuildHandle::refresh`] and every poll of
    /// [`TemplateBuildHandle::wait`].
    pub info: TemplateBuild,
}

impl TemplateBuildHandle {
    /// Re-read the build from the control plane.
    ///
    /// Returns the refreshed representation and updates
    /// [`TemplateBuildHandle::info`].
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the build is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn refresh(&mut self) -> Result<&TemplateBuild, Error> {
        let request = self.http.request(
            Method::GET,
            &format!("/v1/templates/builds/{}", self.info.build_id),
        );
        self.info = self.http.send_json(request).await?;
        Ok(&self.info)
    }

    /// Log entries starting at `offset`. Poll with the returned
    /// `next_offset` until the build reaches a terminal status; a call
    /// at the current end returns an empty page, not an error.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if logs are unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn logs(&self, offset: u64) -> Result<TemplateBuildLogs, Error> {
        let request = self
            .http
            .request(
                Method::GET,
                &format!("/v1/templates/builds/{}/logs", self.info.build_id),
            )
            .query(&[("offset", offset.to_string())]);
        self.http.send_json(request).await
    }

    /// Poll until the build reaches a terminal status.
    ///
    /// Returns the terminal build on success.
    ///
    /// # Errors
    ///
    /// Returns [`Error::BuildFailed`] when the build fails,
    /// [`Error::WaitTimeout`] when the timeout elapses, or the first
    /// API or transport error encountered while polling.
    pub async fn wait(&mut self, options: WaitOptions) -> Result<TemplateBuild, Error> {
        let started = tokio::time::Instant::now();
        loop {
            match self.info.status {
                TemplateBuildStatus::Succeeded => return Ok(self.info.clone()),
                TemplateBuildStatus::Failed => {
                    return Err(Error::BuildFailed {
                        error: self
                            .info
                            .error
                            .clone()
                            .unwrap_or_else(|| "build failed without detail".to_owned()),
                    });
                },
                TemplateBuildStatus::Queued | TemplateBuildStatus::Building => {},
            }
            if let Some(timeout) = options.timeout
                && started.elapsed() >= timeout
            {
                return Err(Error::WaitTimeout);
            }
            tokio::time::sleep(options.poll_interval).await;
            self.refresh().await?;
        }
    }
}
