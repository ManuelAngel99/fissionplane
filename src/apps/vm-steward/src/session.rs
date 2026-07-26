//! The session: handshake, epoch, and effective limits.
//!
//! Reconnection is the ordinary case, not a failure: every pause and
//! every restore severs the vsock connection, so the session model is
//! built around being connected to again. A connection ending is never
//! reported as a fault.

use vm_protocol::codec::{read_frame, write_frame};
use vm_protocol::epoch;
use vm_protocol::proto::frame::Body;
use vm_protocol::proto::{Error, ErrorCode, Frame};
use vm_protocol::session::MAX_HELLO_SIZE;
use vm_protocol::{Capabilities, Limits, PROTOCOL_VERSION, ProtocolError, STREAM_ID_SESSION};

use crate::transport::Stream;

/// Who this agent is, as advertised in `HelloAck`.
#[derive(Clone, Debug)]
pub struct AgentIdentity {
    /// The exact agent build. Its only permitted behavioural use is the
    /// host-side quarantine list; it is never compared as a version.
    pub build_id: String,
    /// What this agent can do. Advertised bits are a promise.
    pub capabilities: Capabilities,
    /// This agent's compile-time limits; the effective ones are the
    /// minimum of both sides.
    pub limits: Limits,
}

impl AgentIdentity {
    /// The identity of the binary being run: package version plus the
    /// capabilities that have landed so far.
    pub fn current() -> Self {
        Self {
            build_id: concat!("vm-steward/", env!("CARGO_PKG_VERSION")).to_owned(),
            // Bits are added as operation areas land. An empty set is an
            // honest advertisement: the host degrades to UNSUPPORTED.
            capabilities: Capabilities::empty(),
            limits: Limits::default_local(),
        }
    }
}

/// An established session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Session {
    /// The epoch the host assigned to this instance.
    pub epoch: u64,
    /// Effective limits: the minimum of the two sides.
    pub limits: Limits,
    /// How the presented epoch related to the one already held.
    pub verdict: vm_protocol::EpochVerdict,
}

/// Handshake failures. A connection that fails the handshake is closed;
/// none of these is recoverable by the peer.
#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
    #[error("first frame on a connection must be Hello on the session stream")]
    ExpectedHello,
    #[error("protocol version mismatch: local {local}, peer {peer}")]
    VersionMismatch { local: u32, peer: u32 },
    #[error("stale epoch {presented} (current {current})")]
    StaleEpoch { current: u64, presented: u64 },
}

/// Run the server half of the handshake on a freshly accepted stream.
///
/// `current_epoch` is the epoch of the session already held, if any. On
/// the very first connection after boot there is none and the presented
/// epoch is adopted; afterwards the monotonic rules apply: a lower epoch
/// is rejected with STALE_EPOCH and the connection closed, a higher one
/// supersedes, an equal one joins.
pub async fn accept<S>(
    stream: &mut S,
    identity: &AgentIdentity,
    current_epoch: Option<u64>,
) -> Result<Session, SessionError>
where
    S: Stream,
{
    let frame = read_frame(stream, MAX_HELLO_SIZE).await?;
    let hello = match (frame.stream_id, frame.body) {
        (STREAM_ID_SESSION, Some(Body::Hello(hello))) => hello,
        _ => return Err(SessionError::ExpectedHello),
    };

    // A version mismatch is fatal: there is no way to interpret the
    // bytes, so there is nothing to negotiate.
    if hello.protocol_version != PROTOCOL_VERSION {
        return Err(SessionError::VersionMismatch {
            local: PROTOCOL_VERSION,
            peer: hello.protocol_version,
        });
    }

    let verdict = match current_epoch {
        None => vm_protocol::EpochVerdict::Join,
        Some(current) => epoch::evaluate(current, hello.epoch),
    };
    if let (Some(current), vm_protocol::EpochVerdict::RejectStale) = (current_epoch, verdict) {
        // Answer with STALE_EPOCH before closing, so the host learns the
        // reason deterministically rather than from a dropped connection.
        let error = Frame {
            stream_id: STREAM_ID_SESSION,
            epoch: current,
            body: Some(Body::Error(Error {
                code: ErrorCode::StaleEpoch.into(),
                message: format!("stale epoch {} (current {current})", hello.epoch),
                required_capability: None,
            })),
        };
        // Best-effort: the peer may already be gone.
        let _ = write_frame(stream, &error, MAX_HELLO_SIZE).await;
        return Err(SessionError::StaleEpoch {
            current,
            presented: hello.epoch,
        });
    }

    let effective = Limits::negotiate(identity.limits, Limits::from_hello(&hello));
    let ack = Frame {
        stream_id: STREAM_ID_SESSION,
        epoch: hello.epoch,
        body: Some(Body::HelloAck(vm_protocol::proto::HelloAck {
            protocol_version: PROTOCOL_VERSION,
            capabilities: identity.capabilities.bits(),
            build_id: identity.build_id.clone(),
            max_frame_size: identity.limits.max_frame_size,
            chunk_size: identity.limits.chunk_size,
        })),
    };
    write_frame(stream, &ack, MAX_HELLO_SIZE).await?;

    Ok(Session {
        epoch: hello.epoch,
        limits: effective,
        verdict,
    })
}
