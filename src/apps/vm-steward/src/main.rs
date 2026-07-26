//! vm-steward entrypoint.
//!
//! Production (Linux, later increment): listen on a fixed virtio-vsock
//! port; vm-host connects in. For development the agent serves the same
//! protocol over a unix socket, which is also how the test harness drives
//! it. The agent never dials out and never binds a TCP or UDP port.

#![forbid(unsafe_code)]

use vm_steward::AgentIdentity;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/tmp/vm-steward.sock".to_owned());
    // A stale socket from a previous run is ours to replace.
    let _ = std::fs::remove_file(&path);
    let listener = tokio::net::UnixListener::bind(&path)?;

    let identity = AgentIdentity::current();
    eprintln!(
        "vm-steward {} listening on {path} (capabilities: {:?})",
        identity.build_id, identity.capabilities
    );

    loop {
        let (mut stream, _peer) = listener.accept().await?;
        let identity = identity.clone();
        tokio::spawn(async move {
            match vm_steward::accept(&mut stream, &identity, None).await {
                Ok(session) => eprintln!("session established: {session:?}"),
                Err(err) => eprintln!("session failed: {err}"),
            }
            // The session loop (stream demultiplexing) lands with the
            // first operation area. A connection ending is routine: every
            // pause severs it.
        });
    }
}
