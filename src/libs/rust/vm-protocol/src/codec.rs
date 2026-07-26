//! Wire framing: a big-endian u32 length prefix followed by a protobuf
//! [`Frame`].
//!
//! The two rules that make hostile input survivable:
//!
//! 1. **The length prefix is validated before any buffer is reserved.**
//!    A frame whose prefix exceeds the maximum causes the read to fail
//!    without reading the body and without allocating for it, so a length
//!    prefix cannot be used to request an arbitrary allocation.
//! 2. **Decoder recursion is bounded.** `prost::Message::decode` runs
//!    with the default recursion limit, and the schema in `proto/vm.proto`
//!    is deliberately acyclic, so nesting depth is bounded by the schema
//!    itself (a few levels), not by attacker input. If a recursive message
//!    is ever added, add a fixture of deeply nested input to the fuzz
//!    corpus in the same change.

use bytes::{BufMut, BytesMut};
use prost::Message;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::ProtocolError;
use crate::proto::Frame;

/// Width of the big-endian length prefix, in bytes.
pub const LENGTH_PREFIX_BYTES: usize = 4;

/// Read one frame, enforcing the size ceiling before allocating.
///
/// Errors of kind [`ProtocolError::FrameTooLarge`] or
/// [`ProtocolError::EmptyFrame`] are connection-fatal by contract: the
/// caller closes without reading further.
pub async fn read_frame<R>(reader: &mut R, max_frame_size: usize) -> Result<Frame, ProtocolError>
where
    R: AsyncRead + Unpin,
{
    let mut prefix = [0u8; LENGTH_PREFIX_BYTES];
    reader.read_exact(&mut prefix).await?;
    let len = u32::from_be_bytes(prefix) as usize;

    if len > max_frame_size {
        return Err(ProtocolError::FrameTooLarge {
            len,
            max: max_frame_size,
        });
    }
    if len == 0 {
        return Err(ProtocolError::EmptyFrame);
    }

    // Allocation happens only now, against a validated length.
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).await?;
    Frame::decode(body.as_slice()).map_err(ProtocolError::Decode)
}

/// Write one frame. Encoding is checked against the same ceiling so a bug
/// on the producing side is caught at the boundary rather than by the
/// peer's reader.
pub async fn write_frame<W>(
    writer: &mut W,
    frame: &Frame,
    max_frame_size: usize,
) -> Result<(), ProtocolError>
where
    W: AsyncWrite + Unpin,
{
    let len = frame.encoded_len();
    if len > max_frame_size {
        return Err(ProtocolError::FrameTooLarge {
            len,
            max: max_frame_size,
        });
    }

    // The ceiling check above bounds `len` by the negotiated maximum,
    // which is far below u32::MAX everywhere in this protocol.
    let len_u32 = u32::try_from(len).map_err(|_| ProtocolError::FrameTooLarge {
        len,
        max: max_frame_size,
    })?;
    let mut buf = BytesMut::with_capacity(LENGTH_PREFIX_BYTES + len);
    buf.put_u32(len_u32);
    frame.encode(&mut buf).map_err(ProtocolError::Encode)?;
    debug_assert_eq!(buf.len(), LENGTH_PREFIX_BYTES + len);

    writer.write_all(&buf).await?;
    writer.flush().await?;
    Ok(())
}
