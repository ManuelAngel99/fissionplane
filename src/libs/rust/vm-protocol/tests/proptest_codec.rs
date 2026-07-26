//! Property tests for the wire framing, complementing the unit tests
//! and the golden fixtures: the golden fixtures pin *known* bytes of
//! the sealed contract; these properties pin the *invariants* every
//! byte sequence must satisfy (docs/components/vm-protocol.md):
//!
//! 1. Any well-formed frame survives a write/read round trip
//!    byte-identically.
//! 2. Arbitrary bytes fed through a valid length prefix never panic or
//!    hang the decoder — framing failure is an `Err`, by the codec's
//!    hostile-input contract (src/codec.rs).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::future::Future;

use proptest::prelude::*;
use tokio::io::AsyncWriteExt;
use vm_protocol::codec::{read_frame, write_frame};
use vm_protocol::proto::frame::Body;
use vm_protocol::proto::{Frame, Ping, Pong};

const MAX: usize = 1024;

fn arb_body() -> impl Strategy<Value = Body> {
    prop_oneof![
        any::<u64>().prop_map(|nonce| Body::Ping(Ping { nonce })),
        any::<u64>().prop_map(|nonce| Body::Pong(Pong { nonce })),
    ]
}

fn arb_frame() -> impl Strategy<Value = Frame> {
    (any::<u64>(), any::<u64>(), arb_body()).prop_map(|(stream_id, epoch, body)| Frame {
        stream_id,
        epoch,
        body: Some(body),
    })
}

/// A current-thread runtime for the async codec inside proptest's
/// synchronous cases. Built per case: proptest drives cases on one
/// thread and the runtime is cheap.
fn run<F: Future>(future: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn any_frame_round_trips(frame in arb_frame()) {
        run(async {
            let (mut a, mut b) = tokio::io::duplex(4096);
            write_frame(&mut a, &frame, MAX).await.unwrap();
            let got = read_frame(&mut b, MAX).await.unwrap();
            prop_assert_eq!(got, frame);
            Ok::<(), TestCaseError>(())
        })?;
    }

    #[test]
    fn arbitrary_bytes_never_panic_the_decoder(
        bytes in proptest::collection::vec(any::<u8>(), 1..MAX),
    ) {
        run(async {
            let (mut a, mut b) = tokio::io::duplex(4096);
            let prefix = u32::try_from(bytes.len()).unwrap().to_be_bytes();
            a.write_all(&prefix).await.unwrap();
            a.write_all(&bytes).await.unwrap();
            drop(a);
            // Ok or Err, but never a panic and never a hang.
            let _ = read_frame(&mut b, MAX).await;
            Ok::<(), TestCaseError>(())
        })?;
    }
}
