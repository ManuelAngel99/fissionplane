//! Ergonomic filesystem operations on a sandbox data plane.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream;
use reqwest::Method;

use crate::client::AgentTarget;
use crate::dataplane::DataPlane;
use crate::error::Error;
use crate::http::Http;
use crate::models::{FileInfo, FileList, FileWatchEvent, MakeDirectoryRequest, MoveFileRequest};
use crate::streaming::EventSocket;
use crate::token::TokenSource;

/// Options for creating a directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MakeDirectoryOptions {
    /// Create missing parent directories.
    pub parents: bool,
    /// Unix permission bits in octal, such as `0755`.
    pub mode: Option<String>,
}

impl Default for MakeDirectoryOptions {
    fn default() -> Self {
        Self {
            parents: true,
            mode: None,
        }
    }
}

/// Options for moving a path.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MovePathOptions {
    /// Replace an existing destination.
    pub overwrite: bool,
}

/// Options for removing a path.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoveOptions {
    /// Recursively remove a directory.
    pub recursive: bool,
}

/// Options for writing file bytes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WriteOptions {
    /// Unix permission bits in octal, such as `0644`.
    pub mode: Option<String>,
}

/// Options for watching filesystem changes.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchOptions {
    /// Include changes below child directories.
    pub recursive: bool,
    /// Last event sequence already observed.
    pub after: u64,
}

/// Filesystem operations inside one sandbox.
///
/// Every request carries the sandbox's capability token as
/// `X-Sandbox-Token`. A token the agent rejects is re-minted through the
/// control plane once and the call is replayed, so a `Files` value keeps
/// working across a resume.
#[derive(Clone, Debug)]
pub struct Files {
    data: DataPlane,
}

impl Files {
    pub(crate) fn new(
        http: &Http,
        agent: &AgentTarget,
        info: &crate::models::Sandbox,
        credential: TokenSource,
    ) -> Result<Self, Error> {
        Ok(Self {
            data: DataPlane::new(http, agent, info, credential)?,
        })
    }

    /// Lists entries directly below `path`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the path cannot be listed or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn list(&self, path: &str) -> Result<Vec<FileInfo>, Error> {
        let request = self
            .data
            .request(Method::GET, "/files")
            .query(&[("path", path)]);
        let list: FileList = self.data.send_json(request).await?;
        Ok(list.items)
    }

    /// Reads metadata for `path`.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the path is unavailable or
    /// [`Error::Http`] if transport or decoding fails.
    pub async fn stat(&self, path: &str) -> Result<FileInfo, Error> {
        let request = self
            .data
            .request(Method::GET, "/files/stat")
            .query(&[("path", path)]);
        self.data.send_json(request).await
    }

    /// Creates a directory.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if creation is rejected or [`Error::Http`]
    /// if transport fails.
    pub async fn make_dir(
        &self,
        path: impl Into<String>,
        options: MakeDirectoryOptions,
    ) -> Result<(), Error> {
        let request =
            self.data
                .request(Method::POST, "/files/directories")
                .json(&MakeDirectoryRequest {
                    path: path.into(),
                    parents: options.parents,
                    mode: options.mode,
                });
        self.data.send_no_content(request).await
    }

    /// Moves or renames a path.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the move is rejected or [`Error::Http`]
    /// if transport fails.
    pub async fn move_path(
        &self,
        source: impl Into<String>,
        destination: impl Into<String>,
        options: MovePathOptions,
    ) -> Result<(), Error> {
        let request = self
            .data
            .request(Method::POST, "/files/move")
            .json(&MoveFileRequest {
                source: source.into(),
                destination: destination.into(),
                overwrite: options.overwrite,
            });
        self.data.send_no_content(request).await
    }

    /// Removes a file or directory.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if removal is rejected or [`Error::Http`]
    /// if transport fails.
    pub async fn remove(&self, path: &str, options: RemoveOptions) -> Result<(), Error> {
        let request = self.data.request(Method::DELETE, "/files").query(&[
            ("path", path.to_owned()),
            ("recursive", options.recursive.to_string()),
        ]);
        self.data.send_no_content(request).await
    }

    /// Downloads a file as bytes.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the file is unavailable or
    /// [`Error::Http`] if transport fails.
    pub async fn read(&self, path: &str) -> Result<Vec<u8>, Error> {
        let request = self
            .data
            .request(Method::GET, "/files/content")
            .query(&[("path", path)]);
        self.data.send_bytes(request).await
    }

    /// Alias for [`Files::read`].
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Files::read`].
    pub async fn download(&self, path: &str) -> Result<Vec<u8>, Error> {
        self.read(path).await
    }

    /// Atomically writes bytes to a file.
    ///
    /// # Errors
    ///
    /// Returns [`Error::Api`] if the write is rejected or [`Error::Http`]
    /// if transport fails.
    pub async fn write(
        &self,
        path: &str,
        bytes: impl Into<Vec<u8>>,
        options: WriteOptions,
    ) -> Result<(), Error> {
        let mut request = self
            .data
            .request(Method::PUT, "/files/content")
            .query(&[("path", path)])
            .header("Content-Type", "application/octet-stream")
            .body(bytes.into());
        if let Some(mode) = options.mode {
            request = request.query(&[("mode", mode)]);
        }
        self.data.send_no_content(request).await
    }

    /// Alias for [`Files::write`].
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Files::write`].
    pub async fn upload(
        &self,
        path: &str,
        bytes: impl Into<Vec<u8>>,
        options: WriteOptions,
    ) -> Result<(), Error> {
        self.write(path, bytes, options).await
    }

    /// Watches a path for filesystem changes.
    ///
    /// A handshake the agent rejects for the token is retried once with
    /// a freshly minted one, so watching works across a resume.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] if the handshake fails,
    /// [`Error::Protocol`] if the server selects the wrong subprotocol,
    /// or [`Error::WaitTimeout`] if the handshake outlives the client's
    /// request timeout.
    pub async fn watch(&self, path: &str, options: WatchOptions) -> Result<FileWatch, Error> {
        let url = self
            .data
            .base()
            .join("/files/watch")
            .map_err(|source| Error::Config(format!("file watch URL: {source}")))?;
        let socket = self
            .data
            .connect(
                url,
                &[
                    ("path", path.to_owned()),
                    ("recursive", options.recursive.to_string()),
                    ("after", options.after.to_string()),
                ],
            )
            .await?;
        Ok(FileWatch { socket })
    }
}

/// A filesystem watch WebSocket with typed events.
#[derive(Debug)]
pub struct FileWatch {
    socket: EventSocket,
}

impl FileWatch {
    /// Closes the WebSocket.
    ///
    /// # Errors
    ///
    /// Returns [`Error::WebSocket`] when closing fails.
    pub async fn close(&mut self) -> Result<(), Error> {
        self.socket.close().await
    }
}

impl Stream for FileWatch {
    type Item = Result<FileWatchEvent, Error>;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        self.get_mut().socket.poll_event(
            cx,
            &["created", "modified", "moved", "removed", "overflow"],
            "file watch",
            valid_file_watch_event,
        )
    }
}

fn valid_file_watch_event(event: &FileWatchEvent) -> bool {
    match event {
        FileWatchEvent::Created { sequence, .. }
        | FileWatchEvent::Modified { sequence, .. }
        | FileWatchEvent::Moved { sequence, .. }
        | FileWatchEvent::Removed { sequence, .. }
        | FileWatchEvent::Overflow { sequence } => *sequence > 0,
    }
}
