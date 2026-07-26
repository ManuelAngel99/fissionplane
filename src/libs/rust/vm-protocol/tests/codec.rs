//! Framing behaviour over in-memory streams.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use vm_protocol::ProtocolError;
use vm_protocol::codec::{read_frame, write_frame};
use vm_protocol::proto::frame::Body;
use vm_protocol::proto::{Frame, Ping};

const MAX: usize = 1024;

fn ping_frame(nonce: u64) -> Frame {
    Frame {
        stream_id: 1,
        epoch: 1,
        body: Some(Body::Ping(Ping { nonce })),
    }
}

#[tokio::test]
async fn round_trip() {
    let (mut a, mut b) = tokio::io::duplex(4096);
    let frame = ping_frame(1234);
    write_frame(&mut a, &frame, MAX).await.unwrap();
    let got = read_frame(&mut b, MAX).await.unwrap();
    assert_eq!(got, frame);
}

#[tokio::test]
async fn oversized_prefix_fails_before_the_body_is_read() {
    let (mut a, mut b) = tokio::io::duplex(4096);
    // A prefix claiming MAX + 1 bytes, followed by that many bytes. The
    // reader must fail on the prefix alone and leave the body untouched.
    let prefix = (u32::try_from(MAX).unwrap() + 1).to_be_bytes();
    let body = vec![0xAA; MAX + 1];
    tokio::io::AsyncWriteExt::write_all(&mut a, &prefix)
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut a, &body)
        .await
        .unwrap();
    // Close the write half so the read_to_end below sees EOF after the
    // buffered bytes instead of waiting forever.
    drop(a);

    let err = read_frame(&mut b, MAX).await.unwrap_err();
    assert!(
        matches!(
            err,
            ProtocolError::FrameTooLarge { len, max } if len == MAX + 1 && max == MAX
        ),
        "unexpected error: {err:?}"
    );

    // The body was never consumed: the peer's bytes are still there, and
    // no allocation of MAX+1 was made against an unvalidated length.
    let mut rest = Vec::new();
    tokio::io::AsyncReadExt::read_to_end(&mut b, &mut rest)
        .await
        .unwrap();
    assert_eq!(rest, body);
}

#[tokio::test]
async fn empty_frame_is_rejected() {
    let (mut a, mut b) = tokio::io::duplex(64);
    tokio::io::AsyncWriteExt::write_all(&mut a, &0u32.to_be_bytes())
        .await
        .unwrap();
    let err = read_frame(&mut b, MAX).await.unwrap_err();
    assert!(matches!(err, ProtocolError::EmptyFrame), "got: {err:?}");
}

#[tokio::test]
async fn writer_enforces_the_same_ceiling() {
    let (mut a, _b) = tokio::io::duplex(4096);
    // A frame whose encoding exceeds the (deliberately tiny) ceiling must
    // fail on the producing side rather than at the peer's reader.
    let err = write_frame(&mut a, &ping_frame(u64::MAX), 4)
        .await
        .unwrap_err();
    assert!(
        matches!(err, ProtocolError::FrameTooLarge { .. }),
        "got: {err:?}"
    );
}

#[tokio::test]
async fn truncated_body_is_an_io_error_not_a_decode_result() {
    let (mut a, mut b) = tokio::io::duplex(64);
    // Prefix claims 8 bytes; only 3 arrive before EOF.
    tokio::io::AsyncWriteExt::write_all(&mut a, &8u32.to_be_bytes())
        .await
        .unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut a, &[0x08, 0x01, 0x10])
        .await
        .unwrap();
    drop(a);
    let err = read_frame(&mut b, MAX).await.unwrap_err();
    assert!(matches!(err, ProtocolError::Io(_)), "got: {err:?}");
}
