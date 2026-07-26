//! Transport abstraction.
//!
//! In production the agent listens on a virtio-vsock port and vm-host
//! connects in. The agent never dials out and never binds a TCP or UDP
//! port — the control channel does not exist on any network the tenant
//! can route to. Everything below that constraint is "a byte stream", so
//! the whole agent can be driven in tests over a duplex or a unix socket.

use tokio::io::{AsyncRead, AsyncWrite};

/// Anything that behaves like a full-duplex byte stream: a vsock
/// connection in production, a duplex or unix-socket pair in tests.
pub trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T> Stream for T where T: AsyncRead + AsyncWrite + Unpin + Send {}
