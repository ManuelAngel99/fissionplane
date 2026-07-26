//! Golden serialization tests: the load-bearing suite for the evolution
//! rules (docs/components/vm-protocol.md).
//!
//! Two assertions run per fixture:
//!   1. the stored bytes still decode into the structure they decoded
//!      into when recorded (catches a reused field number, a changed
//!      type, a redefined meaning);
//!   2. the current encoder reproduces the stored bytes exactly (catches
//!      an encoding change invisible from the decode side).
//!
//! Adding a field adds new fixtures and leaves these passing untouched.
//! A change that modifies a stored fixture is, by definition, a change to
//! the sealed contract.

// Panicking is the assertion mechanism in tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use prost::Message;
use vm_protocol::proto::frame::Body;
use vm_protocol::proto::{Error, ErrorCode, Frame, Hello, HelloAck, Ping, Pong};

/// One canonical message and its exact wire bytes (without the length
/// prefix), with the derivation written out so the fixture can be
/// verified by inspection.
struct Golden {
    name: &'static str,
    frame: Frame,
    /// Hex of the expected encoding.
    hex: &'static str,
}

fn goldens() -> Vec<Golden> {
    vec![
        Golden {
            name: "ping frame, all defaults",
            // Ping{nonce: 0} encodes empty (proto3 omits default scalars);
            // frame field 5 (ping) = tag 0x2A, length 0.
            frame: Frame {
                stream_id: 0,
                epoch: 0,
                body: Some(Body::Ping(Ping { nonce: 0 })),
            },
            hex: "2a00",
        },
        Golden {
            name: "pong frame with stream and epoch",
            // field 1 stream_id=1: 08 01; field 2 epoch=7: 10 07;
            // field 6 (pong) tag 0x32 len 2; Pong{nonce: 42}: 08 2A.
            frame: Frame {
                stream_id: 1,
                epoch: 7,
                body: Some(Body::Pong(Pong { nonce: 42 })),
            },
            hex: "080110073202082a",
        },
        Golden {
            name: "hello frame",
            // Hello{1, 9, 4194304, 1048576}:
            //   08 01 | 10 09 | 18 80808002 (2^22) | 20 808040 (2^20) = 13 bytes.
            // frame field 3 (hello) tag 0x1A len 0x0D.
            frame: Frame {
                stream_id: 0,
                epoch: 0,
                body: Some(Body::Hello(Hello {
                    protocol_version: 1,
                    epoch: 9,
                    max_frame_size: 4 * 1024 * 1024,
                    chunk_size: 1024 * 1024,
                })),
            },
            hex: "1a0d08011009188080800220808040",
        },
        Golden {
            name: "hello-ack frame with capabilities and build id",
            // HelloAck{1, 63, "dev", 4194304, 1048576}:
            //   08 01 | 10 3F | 1A 03 'd''e''v' | 20 80808002 | 28 808040 = 18 bytes.
            // frame field 4 (hello_ack) tag 0x22 len 0x12.
            frame: Frame {
                stream_id: 0,
                epoch: 0,
                body: Some(Body::HelloAck(HelloAck {
                    protocol_version: 1,
                    capabilities: 63,
                    build_id: "dev".to_owned(),
                    max_frame_size: 4 * 1024 * 1024,
                    chunk_size: 1024 * 1024,
                })),
            },
            hex: "22120801103f1a03646576208080800228808040",
        },
        Golden {
            name: "stale-epoch error frame",
            // Error{code: STALE_EPOCH (2), message: ""}: 08 02 (empty message
            // omitted). frame field 7 (error) tag 0x3A len 2.
            frame: Frame {
                stream_id: 0,
                epoch: 0,
                body: Some(Body::Error(Error {
                    code: ErrorCode::StaleEpoch.into(),
                    message: String::new(),
                    required_capability: None,
                })),
            },
            hex: "3a020802",
        },
    ]
}

#[test]
fn fixtures_still_decode() {
    for golden in goldens() {
        let bytes = hex::decode(golden.hex).expect("fixture hex is valid");
        let decoded = Frame::decode(bytes.as_slice())
            .unwrap_or_else(|e| panic!("fixture {:?} no longer decodes: {e}", golden.name));
        assert_eq!(
            decoded, golden.frame,
            "fixture {:?} decodes to a different structure",
            golden.name
        );
    }
}

#[test]
fn encoder_reproduces_stored_bytes() {
    for golden in goldens() {
        let expected = hex::decode(golden.hex).expect("fixture hex is valid");
        let mut actual = Vec::new();
        golden
            .frame
            .encode(&mut actual)
            .unwrap_or_else(|e| panic!("fixture {:?} failed to encode: {e}", golden.name));
        assert_eq!(
            actual, expected,
            "fixture {:?}: encoder output changed",
            golden.name
        );
    }
}
