//! vm-steward: the only program inside a sandbox that vm-host talks to.
//!
//! Design constraints (docs/components/vm-steward.md):
//!
//! - the binary is sealed into snapshots, so the surface stays small and
//!   every capability needs a guest syscall to justify its existence;
//! - it never binds a TCP or UDP port: vsock in production, any byte
//!   stream in tests ("each box is a module with no knowledge of the
//!   transport beyond a stream handle");
//! - it performs no authentication — the occupant is root in the guest,
//!   so the check belongs on the host side of the boundary;
//! - it never shells out, never serves HTTP, and never carries public
//!   API types;
//! - a connection ending is routine, not an error: every pause severs
//!   the connection through the vsock transport reset.

#![forbid(unsafe_code)]
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

pub mod session;
pub mod transport;

pub use session::{AgentIdentity, Session, SessionError, accept};
