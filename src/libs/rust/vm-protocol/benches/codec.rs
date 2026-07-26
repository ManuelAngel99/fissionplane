//! Serialization hot-path benchmarks for the sealed framing (divan).
//!
//! The vsock channel is on every sandbox operation's critical path; the
//! async read/write half is exercised by the test suite, so these
//! benches isolate the pure encode/decode cost where a regression would
//! otherwise hide. Run with `just bench`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use prost::Message as _;
use vm_protocol::proto::frame::Body;
use vm_protocol::proto::{Frame, Ping};

fn main() {
    divan::main();
}

fn ping_frame(nonce: u64) -> Frame {
    Frame {
        stream_id: 1,
        epoch: 1,
        body: Some(Body::Ping(Ping { nonce })),
    }
}

#[divan::bench]
fn encode_frame(bencher: divan::Bencher) {
    let frame = ping_frame(42);
    bencher.bench(|| frame.encode_to_vec());
}

#[divan::bench]
fn decode_frame(bencher: divan::Bencher) {
    let bytes = ping_frame(42).encode_to_vec();
    bencher.bench(|| Frame::decode(bytes.as_slice()).unwrap());
}
