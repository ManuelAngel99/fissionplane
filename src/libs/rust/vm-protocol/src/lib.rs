//! vm-protocol: the sealed wire contract between vm-host and vm-steward.
//!
//! This is the one interface sealed into snapshots, and therefore the one
//! interface that must not churn (docs/components/vm-protocol.md). The
//! rules that matter most:
//!
//! - frames are length-prefixed (big-endian u32) protobuf [`proto::Frame`]s;
//! - the length prefix is validated before any allocation happens;
//! - stream ids are host-allocated, monotonic per connection, never reused;
//! - epochs are monotonic: a lower epoch is rejected, a higher one supersedes;
//! - capability bits are permanent and never recycled;
//! - public API types never enter this crate.

#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

#[allow(clippy::all, clippy::pedantic, clippy::nursery)]
pub mod proto {
    include!(concat!(env!("OUT_DIR"), "/fissionplane.vmproto.v1.rs"));
}

pub mod capability;
pub mod codec;
pub mod epoch;
pub mod session;

pub use capability::Capabilities;
pub use epoch::EpochVerdict;
pub use session::{Limits, PROTOCOL_VERSION, STREAM_ID_SESSION};

/// Errors at the framing layer.
///
/// [`ProtocolError::FrameTooLarge`] and [`ProtocolError::EmptyFrame`] are
/// connection-fatal by contract: the peer closes without reading further,
/// so a length prefix can never be used to request an allocation.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame length {len} exceeds maximum {max}")]
    FrameTooLarge { len: usize, max: usize },
    #[error("frame has an empty body")]
    EmptyFrame,
    #[error("failed to decode frame: {0}")]
    Decode(#[from] prost::DecodeError),
    #[error("failed to encode frame: {0}")]
    Encode(#[from] prost::EncodeError),
}
