//! Session constants and limit negotiation.
//!
//! The handshake is the first exchange after connect, before any
//! operation is legal: the host sends `Hello`, the guest answers
//! `HelloAck`, and the effective limits are the minimum of the two sides.

use crate::proto::{Hello, HelloAck};

/// Generation of the wire format itself — the framing, the envelope, the
/// handshake — and not a feature level. Feature level is the capability
/// bitset. This changes essentially never, and a mismatch is fatal
/// because there is no way to interpret the bytes.
pub const PROTOCOL_VERSION: u32 = 1;

/// Stream id 0 is the session stream. Host-allocated ids start at 1 and
/// increase monotonically per connection; they are never reused, and a
/// connection that exhausts the space is retired rather than wrapped.
pub const STREAM_ID_SESSION: u64 = 0;

/// Compile-time default for the largest legal frame. Both sides enforce
/// their own constant and advertise it; the effective value is the
/// minimum. A single ceiling that everything fits under is what keeps
/// memory bounded on both sides.
pub const DEFAULT_MAX_FRAME_SIZE: u32 = 4 * 1024 * 1024;

/// Compile-time default payload-chunk size, advertised in the handshake.
/// Payloads larger than a frame are chunked at the protocol level rather
/// than by raising the frame ceiling.
pub const DEFAULT_CHUNK_SIZE: u32 = 1024 * 1024;

/// Bound applied to the handshake itself, before limits are negotiated.
/// Handshake messages are small and carry no bulk data.
pub const MAX_HELLO_SIZE: usize = 64 * 1024;

/// Frame and chunk limits for one peer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_frame_size: u32,
    pub chunk_size: u32,
}

impl Limits {
    /// This side's compile-time defaults.
    pub const fn default_local() -> Self {
        Self {
            max_frame_size: DEFAULT_MAX_FRAME_SIZE,
            chunk_size: DEFAULT_CHUNK_SIZE,
        }
    }

    /// Effective limits are the minimum of the two sides, so neither side
    /// has to guess what the other will accept.
    pub fn negotiate(local: Self, peer: Self) -> Self {
        Self {
            max_frame_size: local.max_frame_size.min(peer.max_frame_size),
            chunk_size: local.chunk_size.min(peer.chunk_size),
        }
    }

    /// Limits advertised by the host.
    pub fn from_hello(hello: &Hello) -> Self {
        Self {
            max_frame_size: hello.max_frame_size,
            chunk_size: hello.chunk_size,
        }
    }

    /// Limits advertised by the agent.
    pub fn from_hello_ack(ack: &HelloAck) -> Self {
        Self {
            max_frame_size: ack.max_frame_size,
            chunk_size: ack.chunk_size,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn negotiation_takes_the_minimum() {
        let local = Limits {
            max_frame_size: 8,
            chunk_size: 4,
        };
        let peer = Limits {
            max_frame_size: 2,
            chunk_size: 16,
        };
        let effective = Limits::negotiate(local, peer);
        assert_eq!(
            effective,
            Limits {
                max_frame_size: 2,
                chunk_size: 4
            }
        );
    }
}
