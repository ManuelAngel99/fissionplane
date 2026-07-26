//! Rust client for the fissionplane control and data plane APIs.
//!
//! [`FissionPlane`] provides access to sandboxes and templates. A
//! [`Sandbox`] carries its latest representation and, when available,
//! a capability token for data-plane operations through [`Commands`].
//!
//! # Quick start
//!
//! ```no_run
//! use fissionplane::models::{CreateSandboxRequest, RunCommandRequest};
//! use fissionplane::{ClientOptions, FissionPlane};
//!
//! # async fn quick_start() -> Result<(), fissionplane::Error> {
//! let client = FissionPlane::new(ClientOptions::new())?;
//!
//! let mut sandbox = client
//!     .sandboxes()
//!     .create(
//!         CreateSandboxRequest {
//!             template: "base".to_owned(),
//!             ..Default::default()
//!         },
//!         None,
//!     )
//!     .await?;
//!
//! let result = sandbox
//!     .commands()?
//!     .run(RunCommandRequest {
//!         command: "echo".to_owned(),
//!         args: Some(vec!["hello".to_owned()]),
//!         ..Default::default()
//!     })
//!     .await?;
//! println!("{}", result.stdout);
//!
//! sandbox.pause().await?;
//! # Ok(())
//! # }
//! ```

mod client;
mod commands;
mod config;
mod dataplane;
mod error;
mod files;
mod http;
pub mod models;
mod ports;
mod retry;
mod sandboxes;
mod streaming;
mod templates;
mod token;

pub use client::FissionPlane;
pub use commands::{Commands, ProcessAttachment, ProcessHandle, Signal};
pub use config::{ClientOptions, DEFAULT_AGENT_PORT, DEFAULT_MAX_RETRIES, DEFAULT_REQUEST_TIMEOUT};
pub use error::Error;
pub use files::{
    FileWatch, Files, MakeDirectoryOptions, MovePathOptions, RemoveOptions, WatchOptions,
    WriteOptions,
};
pub use ports::Ports;
pub use sandboxes::{ListSandboxesFilter, Sandbox, Sandboxes};
pub use templates::{TemplateBuildHandle, Templates, WaitOptions};
/// URL type accepted by [`ClientOptions::agent_base_url_override`].
pub use url::Url;
