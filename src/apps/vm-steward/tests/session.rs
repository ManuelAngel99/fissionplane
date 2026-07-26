//! The fake host drives the real agent over an in-memory stream: the
//! same protocol, the same code paths, no VM.

// Panicking is the assertion mechanism in tests.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use vm_protocol::codec::{read_frame, write_frame};
use vm_protocol::proto::frame::Body;
use vm_protocol::proto::{ErrorCode, Frame, Hello};
use vm_protocol::{Capabilities, EpochVerdict, Limits, PROTOCOL_VERSION, STREAM_ID_SESSION};
use vm_steward::{AgentIdentity, SessionError, accept};

const MAX: usize = 64 * 1024;

fn identity() -> AgentIdentity {
    AgentIdentity {
        build_id: "vm-steward/test".to_owned(),
        capabilities: Capabilities::empty()
            .with(Capabilities::PROCESSES)
            .with(Capabilities::STATS),
        limits: Limits::default_local(),
    }
}

fn hello(epoch: u64, protocol_version: u32) -> Frame {
    Frame {
        stream_id: STREAM_ID_SESSION,
        epoch: 0,
        body: Some(Body::Hello(Hello {
            protocol_version,
            epoch,
            max_frame_size: 2 * 1024 * 1024,
            chunk_size: 512 * 1024,
        })),
    }
}

#[tokio::test]
async fn handshake_negotiates_minimum_limits_and_advertises_identity() {
    let (mut host, mut guest) = tokio::io::duplex(4096);
    let identity = identity();

    let server = tokio::spawn(async move { accept(&mut guest, &identity, None).await });

    write_frame(&mut host, &hello(7, PROTOCOL_VERSION), MAX)
        .await
        .unwrap();
    let ack_frame = read_frame(&mut host, MAX).await.unwrap();
    let ack = match ack_frame.body {
        Some(Body::HelloAck(ack)) => ack,
        other => panic!("expected HelloAck, got {other:?}"),
    };

    assert_eq!(ack.protocol_version, PROTOCOL_VERSION);
    assert_eq!(ack.build_id, "vm-steward/test");
    assert!(ack.capabilities & Capabilities::PROCESSES != 0);
    assert!(ack.capabilities & Capabilities::FILESYSTEM == 0);
    // Agent's own compile-time limits go on the wire, not the negotiated
    // ones; negotiation is the session's result, below.
    assert_eq!(ack.max_frame_size, Limits::default_local().max_frame_size);

    let session = server.await.unwrap().unwrap();
    assert_eq!(session.epoch, 7);
    assert_eq!(session.verdict, EpochVerdict::Join);
    assert_eq!(session.limits.max_frame_size, 2 * 1024 * 1024); // host's, smaller
    assert_eq!(session.limits.chunk_size, 512 * 1024); // host's, smaller
}

#[tokio::test]
async fn first_frame_that_is_not_hello_fails_the_connection() {
    let (mut host, mut guest) = tokio::io::duplex(4096);
    let identity = identity();
    let server = tokio::spawn(async move { accept(&mut guest, &identity, None).await });

    let ping = Frame {
        stream_id: STREAM_ID_SESSION,
        epoch: 0,
        body: Some(Body::Ping(vm_protocol::proto::Ping { nonce: 1 })),
    };
    write_frame(&mut host, &ping, MAX).await.unwrap();

    let err = server.await.unwrap().unwrap_err();
    assert!(matches!(err, SessionError::ExpectedHello), "got: {err:?}");
}

#[tokio::test]
async fn protocol_version_mismatch_is_fatal() {
    let (mut host, mut guest) = tokio::io::duplex(4096);
    let identity = identity();
    let server = tokio::spawn(async move { accept(&mut guest, &identity, None).await });

    write_frame(&mut host, &hello(1, PROTOCOL_VERSION + 1), MAX)
        .await
        .unwrap();

    let err = server.await.unwrap().unwrap_err();
    assert!(
        matches!(err, SessionError::VersionMismatch { local, peer } if local == PROTOCOL_VERSION && peer == PROTOCOL_VERSION + 1),
        "got: {err:?}"
    );
}

#[tokio::test]
async fn a_lower_epoch_is_rejected_with_stale_epoch_and_the_connection_closes() {
    let (mut host, mut guest) = tokio::io::duplex(4096);
    let identity = identity();
    // A session at epoch 10 already exists; a host presenting epoch 9 can
    // only be stale.
    let server = tokio::spawn(async move { accept(&mut guest, &identity, Some(10)).await });

    write_frame(&mut host, &hello(9, PROTOCOL_VERSION), MAX)
        .await
        .unwrap();

    // The agent answers with a STALE_EPOCH error frame before closing.
    let error_frame = read_frame(&mut host, MAX).await.unwrap();
    match error_frame.body {
        Some(Body::Error(err)) => {
            assert_eq!(err.code, ErrorCode::StaleEpoch as i32);
        },
        other => panic!("expected Error, got {other:?}"),
    }

    let err = server.await.unwrap().unwrap_err();
    assert!(
        matches!(
            err,
            SessionError::StaleEpoch {
                current: 10,
                presented: 9
            }
        ),
        "got: {err:?}"
    );
}

#[tokio::test]
async fn a_higher_epoch_supersedes_and_becomes_current() {
    let (mut host, mut guest) = tokio::io::duplex(4096);
    let identity = identity();
    let server = tokio::spawn(async move { accept(&mut guest, &identity, Some(10)).await });

    write_frame(&mut host, &hello(11, PROTOCOL_VERSION), MAX)
        .await
        .unwrap();
    let _ack = read_frame(&mut host, MAX).await.unwrap();

    let session = server.await.unwrap().unwrap();
    assert_eq!(session.epoch, 11);
    assert_eq!(session.verdict, EpochVerdict::Supersede);
}
