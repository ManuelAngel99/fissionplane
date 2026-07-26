//! The sandbox collection and the [`Sandbox`] handle.

use std::collections::BTreeMap;
use std::sync::Arc;

use futures_util::{Stream, StreamExt, TryStreamExt, stream};
use reqwest::Method;
use tracing::debug;

use crate::client::AgentTarget;
use crate::commands::Commands;
use crate::error::Error;
use crate::files::Files;
use crate::http::{self, Http};
use crate::models;
use crate::models::{
    CapabilityToken, CreateSandboxRequest, ExtendDeadlineRequest, MintTokenRequest,
    ResumeSandboxRequest, SandboxList, SandboxState, SandboxWithToken,
};
use crate::ports::Ports;
use crate::token::TokenSource;

/// Filters for [`Sandboxes::list`], [`Sandboxes::stream`], and
/// [`Sandboxes::list_all`].
#[derive(Clone, Debug, Default)]
pub struct ListSandboxesFilter {
    /// Keep only sandboxes in this state.
    pub state: Option<SandboxState>,
    /// Exact match on the tenant-assigned name.
    pub name: Option<String>,
    /// Keep only sandboxes carrying every one of these metadata pairs.
    /// A `BTreeMap` so the encoded filter is deterministic.
    pub metadata: Option<BTreeMap<String, String>>,
    /// Page size, 1–100. Omitted means the server default.
    pub limit: Option<u32>,
    /// Opaque cursor from a previous page's `next_cursor`.
    pub cursor: Option<String>,
}

impl ListSandboxesFilter {
    fn encoded_metadata(metadata: &BTreeMap<String, String>) -> String {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        for (key, value) in metadata {
            serializer.append_pair(key, value);
        }
        serializer.finish()
    }

    fn query(&self) -> Vec<(&'static str, String)> {
        let mut query = Vec::new();
        if let Some(state) = self.state {
            query.push(("state", state.as_str().to_owned()));
        }
        if let Some(name) = &self.name {
            query.push(("name", name.clone()));
        }
        if let Some(metadata) = &self.metadata {
            query.push(("metadata", Self::encoded_metadata(metadata)));
        }
        if let Some(limit) = self.limit {
            query.push(("limit", limit.to_string()));
        }
        if let Some(cursor) = &self.cursor {
            query.push(("cursor", cursor.clone()));
        }
        query
    }
}

/// Operations on the sandbox collection. Obtained from
/// [`crate::FissionPlane::sandboxes`].
#[derive(Clone, Debug)]
pub struct Sandboxes {
    http: Arc<Http>,
    agent: AgentTarget,
}

impl Sandboxes {
    pub(crate) fn new(http: Arc<Http>, agent: AgentTarget) -> Self {
        Self { http, agent }
    }

    /// Create a sandbox and block until a node has acknowledged it.
    ///
    /// The returned handle carries the capability token the create
    /// minted, so [`Sandbox::commands`] works immediately.
    ///
    /// `idempotency_key` makes retries safe: a retry with the same key
    /// returns the sandbox the first attempt created rather than
    /// creating a second one.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use fissionplane::models::CreateSandboxRequest;
    ///
    /// # async fn demo(client: fissionplane::FissionPlane) -> Result<(), fissionplane::Error> {
    /// let sandbox = client
    ///     .sandboxes()
    ///     .create(
    ///         CreateSandboxRequest {
    ///             template: "base".to_owned(),
    ///             ..Default::default()
    ///         },
    ///         Some("build-42"),
    ///     )
    ///     .await?;
    /// println!("{} at {}", sandbox.info.sandbox_id, sandbox.hostname(3000));
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if creation is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn create(
        &self,
        request: CreateSandboxRequest,
        idempotency_key: Option<&str>,
    ) -> Result<Sandbox, Error> {
        let mut builder = self
            .http
            .request(Method::POST, "/v1/sandboxes")
            .json(&request);
        if let Some(key) = idempotency_key {
            // The key is also what makes this create retryable: without
            // one, the transport never replays a POST.
            builder = builder.header(http::IDEMPOTENCY_KEY, key);
        }
        let result: SandboxWithToken = self.http.send_json(builder).await?;
        Ok(Sandbox::new(
            Arc::clone(&self.http),
            self.agent.clone(),
            result.sandbox,
            Some(result.token),
        ))
    }

    /// Fetch one sandbox by identifier.
    ///
    /// The handle carries no capability token: only create, resume,
    /// and mint operations produce one.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the sandbox is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn get(&self, sandbox_id: &str) -> Result<Sandbox, Error> {
        let request = self
            .http
            .request(Method::GET, &format!("/v1/sandboxes/{sandbox_id}"));
        let info: models::Sandbox = self.http.send_json(request).await?;
        Ok(Sandbox::new(
            Arc::clone(&self.http),
            self.agent.clone(),
            info,
            None,
        ))
    }

    /// One page of sandboxes, most recently created first. Pass the
    /// page's `next_cursor` back in the filter for the next page, or
    /// use [`Sandboxes::stream`] or [`Sandboxes::list_all`].
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the request is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn list(&self, filter: ListSandboxesFilter) -> Result<SandboxList, Error> {
        self.list_page(&filter).await
    }

    async fn list_page(&self, filter: &ListSandboxesFilter) -> Result<SandboxList, Error> {
        debug!(
            cursor = filter.cursor.as_deref().unwrap_or("<first>"),
            limit = filter.limit,
            "fetching a page of sandboxes",
        );
        let request = self
            .http
            .request(Method::GET, "/v1/sandboxes")
            .query(&filter.query());
        self.http.send_json(request).await
    }

    /// Every sandbox the filter matches, one at a time, fetching the
    /// next page only when the current one is exhausted.
    ///
    /// Prefer this to [`Sandboxes::list_all`] for a large collection:
    /// only one page is in memory at a time, and a caller that stops
    /// early never asks for the rest. The filter's own `cursor` field
    /// sets where to start. Yielded handles carry no capability token,
    /// exactly like [`Sandboxes::get`].
    ///
    /// The stream ends after the first error; a fresh call resumes from
    /// wherever the caller last saw a cursor.
    ///
    /// # Examples
    ///
    /// ```no_run
    /// use futures_util::StreamExt;
    /// use fissionplane::ListSandboxesFilter;
    /// use fissionplane::models::SandboxState;
    ///
    /// # async fn demo(client: fissionplane::FissionPlane) -> Result<(), fissionplane::Error> {
    /// let mut running = client.sandboxes().stream(ListSandboxesFilter {
    ///     state: Some(SandboxState::Running),
    ///     ..Default::default()
    /// });
    /// while let Some(sandbox) = running.next().await {
    ///     println!("{}", sandbox?.info.sandbox_id);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub fn stream(
        &self,
        filter: ListSandboxesFilter,
    ) -> impl Stream<Item = Result<Sandbox, Error>> + Send + Unpin + use<> {
        let sandboxes = self.clone();
        // `None` is the state after the page that had no `next_cursor`.
        stream::try_unfold(Some(filter), move |state| {
            let sandboxes = sandboxes.clone();
            async move {
                let Some(mut filter) = state else {
                    return Ok(None);
                };
                let page = sandboxes.list_page(&filter).await?;
                let items: Vec<Result<Sandbox, Error>> = page
                    .items
                    .into_iter()
                    .map(|info| {
                        Ok(Sandbox::new(
                            Arc::clone(&sandboxes.http),
                            sandboxes.agent.clone(),
                            info,
                            None,
                        ))
                    })
                    .collect();
                let next = page.next_cursor.map(|cursor| {
                    filter.cursor = Some(cursor);
                    filter
                });
                // `?` above cannot pin the error type on its own: the
                // enum has several `From` impls.
                Ok::<_, Error>(Some((stream::iter(items), next)))
            }
        })
        .try_flatten()
        // Boxed so the stream is `Unpin`: a caller should be able to
        // hold it in a `let mut` and poll it in a `while let` loop
        // without pinning it first.
        .boxed()
    }

    /// Every sandbox the filter matches, following `next_cursor` until
    /// the last page. The filter's own `cursor` field sets where to
    /// start.
    ///
    /// # Errors
    ///
    /// Returns the first [`Error`] encountered while fetching pages.
    pub async fn list_all(
        &self,
        filter: ListSandboxesFilter,
    ) -> Result<Vec<models::Sandbox>, Error> {
        let mut filter = filter;
        let mut all = Vec::new();
        loop {
            let page = self.list_page(&filter).await?;
            all.extend(page.items);
            match page.next_cursor {
                Some(cursor) => filter.cursor = Some(cursor),
                None => return Ok(all),
            }
        }
    }
}

/// A live handle on one sandbox.
///
/// Holds the latest known representation in [`Sandbox::info`] and,
/// when obtained from an operation that mints one (create, resume,
/// [`Sandbox::mint_token`]), the capability token for the current
/// epoch in [`Sandbox::token`]. [`Sandbox::resume`] replaces the token
/// because the resumed instance has a new epoch and the old token
/// fails closed.
///
/// The token is shared with the data-plane modules this handle builds,
/// which re-mint it when the agent rejects it. Read
/// [`Sandbox::current_token`] rather than [`Sandbox::token`] to see a
/// token minted that way.
#[derive(Clone, Debug)]
pub struct Sandbox {
    http: Arc<Http>,
    agent: AgentTarget,
    /// The shared, refreshable view of `token`. `None` exactly when
    /// `token` is `None`.
    credential: Option<TokenSource>,
    /// Last representation fetched; refreshed by every lifecycle
    /// operation on this handle.
    pub info: models::Sandbox,
    /// Token for the current epoch, as this handle last stored it.
    ///
    /// A data-plane call takes `&self` and so cannot write here: when
    /// one re-mints a rejected token, the new token appears in
    /// [`Sandbox::current_token`] instead.
    pub token: Option<CapabilityToken>,
}

impl Sandbox {
    pub(crate) fn new(
        http: Arc<Http>,
        agent: AgentTarget,
        info: models::Sandbox,
        token: Option<CapabilityToken>,
    ) -> Self {
        let credential = token
            .clone()
            .map(|token| TokenSource::new(Arc::clone(&http), info.sandbox_id.clone(), token));
        Self {
            http,
            agent,
            credential,
            info,
            token,
        }
    }

    fn path(&self, suffix: &str) -> String {
        format!("/v1/sandboxes/{}{suffix}", self.info.sandbox_id)
    }

    /// Stores a freshly minted token, publishing it to the data-plane
    /// modules this handle has already built.
    fn arm(&mut self, token: CapabilityToken) {
        match &self.credential {
            Some(credential) => credential.replace(token.clone()),
            None => {
                self.credential = Some(TokenSource::new(
                    Arc::clone(&self.http),
                    self.info.sandbox_id.clone(),
                    token.clone(),
                ));
            },
        }
        self.token = Some(token);
    }

    /// The freshest capability token known for this sandbox.
    ///
    /// Same as [`Sandbox::token`] until a data-plane call re-mints a
    /// rejected token, which it does through a shared cell rather than
    /// through this handle. Returns `None` when no token was ever
    /// minted.
    pub fn current_token(&self) -> Option<CapabilityToken> {
        match &self.credential {
            Some(credential) => Some(credential.current()),
            None => self.token.clone(),
        }
    }

    /// The public hostname of a published port:
    /// `<port>-<sandbox_id>.<domain>`.
    ///
    /// Returns the hostname without a URL scheme.
    pub fn hostname(&self, port: u16) -> String {
        format!("{port}-{}.{}", self.info.sandbox_id, self.info.domain)
    }

    /// Re-read the sandbox from the control plane.
    ///
    /// Returns the refreshed representation and updates [`Sandbox::info`].
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the sandbox is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn refresh(&mut self) -> Result<&models::Sandbox, Error> {
        let request = self.http.request(Method::GET, &self.path(""));
        self.info = self.http.send_json(request).await?;
        Ok(&self.info)
    }

    /// Snapshot the sandbox and release its node capacity. Complete
    /// when the node reports the VM snapshotted; `restorable_until` on
    /// the refreshed info records how long the snapshot stays
    /// restorable.
    ///
    /// Returns the paused representation and updates [`Sandbox::info`].
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the sandbox cannot be paused or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn pause(&mut self) -> Result<&models::Sandbox, Error> {
        let request = self.http.request(Method::POST, &self.path("/pause"));
        self.info = self.http.send_json(request).await?;
        Ok(&self.info)
    }

    /// Restore the snapshot onto a node.
    ///
    /// The resumed instance carries a new epoch, so tokens minted
    /// against the previous instance fail closed; the handle's
    /// [`Sandbox::token`] is replaced by the fresh one this operation
    /// returns.
    ///
    /// `deadline_seconds` sets the resumed lease length when provided.
    /// Returns the resumed representation.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the sandbox cannot be resumed or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn resume(
        &mut self,
        deadline_seconds: Option<u64>,
    ) -> Result<&models::Sandbox, Error> {
        let mut request = self.http.request(Method::POST, &self.path("/resume"));
        if deadline_seconds.is_some() {
            request = request.json(&ResumeSandboxRequest { deadline_seconds });
        }
        let result: SandboxWithToken = self.http.send_json(request).await?;
        self.info = result.sandbox;
        self.arm(result.token);
        Ok(&self.info)
    }

    /// Set the deadline to now plus `deadline_seconds`, bounded by the
    /// installation's maximum lease.
    ///
    /// Returns the updated representation.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the deadline is rejected or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn extend_deadline(
        &mut self,
        deadline_seconds: u64,
    ) -> Result<&models::Sandbox, Error> {
        let request = self
            .http
            .request(Method::POST, &self.path("/deadline"))
            .json(&ExtendDeadlineRequest { deadline_seconds });
        self.info = self.http.send_json(request).await?;
        Ok(&self.info)
    }

    /// Mint a capability token for the current epoch. Pass `ports` in
    /// the request to mint an attenuated token (a scope can only
    /// narrow) — suitable for a browser one-time link.
    ///
    /// The handle keeps the newest token, so `mint_token` also re-arms
    /// [`Sandbox::commands`] on a handle that had none.
    ///
    /// Returns the new token.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the token cannot be minted or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn mint_token(
        &mut self,
        request: MintTokenRequest,
    ) -> Result<CapabilityToken, Error> {
        let builder = self
            .http
            .request(Method::POST, &self.path("/token"))
            .json(&request);
        let token: CapabilityToken = self.http.send_json(builder).await?;
        self.arm(token.clone());
        Ok(token)
    }

    /// Terminate the sandbox, consuming the handle. Deleting a paused
    /// sandbox also releases its snapshot. The record remains readable
    /// as `terminated` via [`Sandboxes::get`].
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if deletion is rejected or
    /// [`Error::Http`] if transport fails.
    pub async fn delete(self) -> Result<(), Error> {
        let request = self.http.request(Method::DELETE, &self.path(""));
        self.http.send_no_content(request).await
    }

    /// Port exposure records for this sandbox.
    ///
    /// Returns a handle that shares the client connection pool.
    pub fn ports(&self) -> Ports {
        Ports::new(Arc::clone(&self.http), self.info.sandbox_id.clone())
    }

    /// Command execution on this sandbox's data plane.
    ///
    /// The returned value shares this handle's token and re-mints it
    /// when the agent rejects one, so it stays usable across a resume.
    ///
    /// # Errors
    ///
    /// [`Error::MissingToken`] when the handle carries no capability
    /// token — resume the sandbox or call [`Sandbox::mint_token`]
    /// first. Returns [`Error::Config`] if the data-plane URL cannot be
    /// built.
    pub fn commands(&self) -> Result<Commands, Error> {
        let credential = self.credential.clone().ok_or(Error::MissingToken)?;
        Commands::new(&self.http, &self.agent, &self.info, credential)
    }

    /// Filesystem access on this sandbox's data plane.
    ///
    /// The returned value shares this handle's token and re-mints it
    /// when the agent rejects one.
    ///
    /// # Errors
    ///
    /// [`Error::MissingToken`] when the handle carries no capability
    /// token. Returns [`Error::Config`] if the data-plane URL cannot be
    /// built.
    pub fn files(&self) -> Result<Files, Error> {
        let credential = self.credential.clone().ok_or(Error::MissingToken)?;
        Files::new(&self.http, &self.agent, &self.info, credential)
    }
}
