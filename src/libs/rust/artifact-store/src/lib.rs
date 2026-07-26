//! artifact-store: the one library permitted to read or write artifact
//! bytes (docs/components/artifact-store.md). It is linked into
//! vm-host, template-builder, and control-plane — a library plus an
//! object storage bucket, deliberately not a service: artifact reads
//! sit on the sandbox-start critical path and, in the cold case,
//! inside the userfaultfd fault loop, where an extra hop is
//! unacceptable.
//!
//! Stub: the artifact identity type only. The manifest format, the
//! source-map sidecar, chunked ranged reads into a local sparse file,
//! the integrity check every artifact byte receives, and the node
//! cache with its eviction and pinning policy land here; the format
//! this crate will enforce is specified in
//! docs/architecture/snapshots.md.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::str::FromStr;

use thiserror::Error;

/// Prefix identifying the artifact digest algorithm.
pub const ARTIFACT_ID_PREFIX: &str = "sha256:";
/// Hexadecimal digest length for SHA-256.
pub const ARTIFACT_DIGEST_HEX_LENGTH: usize = 64;
/// Total serialized artifact identifier length.
pub const ARTIFACT_ID_LENGTH: usize = ARTIFACT_ID_PREFIX.len() + ARTIFACT_DIGEST_HEX_LENGTH;

/// Content-addressed identity of an immutable artifact.
///
/// Every artifact is self-contained per the snapshot design: lineage
/// is provenance recorded at publish time, never something a read has
/// to resolve.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ArtifactId(String);

/// An artifact content digest is malformed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("artifact ID must be a lowercase SHA-256 digest")]
pub struct ArtifactIdError;

impl ArtifactId {
    /// Parse and validate a lowercase SHA-256 content digest.
    ///
    /// # Errors
    ///
    /// Returns [`ArtifactIdError`] when the value is not
    /// `sha256:` followed by 64 lowercase hexadecimal characters.
    pub fn parse(id: impl Into<String>) -> Result<Self, ArtifactIdError> {
        let id = id.into();
        let Some(digest) = id.strip_prefix(ARTIFACT_ID_PREFIX) else {
            return Err(ArtifactIdError);
        };
        if digest.len() != ARTIFACT_DIGEST_HEX_LENGTH
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ArtifactIdError);
        }
        Ok(Self(id))
    }

    /// The raw content address.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl FromStr for ArtifactId {
    type Err = ArtifactIdError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

impl std::fmt::Display for ArtifactId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_round_trips() {
        let value = format!(
            "{ARTIFACT_ID_PREFIX}{}",
            "a".repeat(ARTIFACT_DIGEST_HEX_LENGTH)
        );
        let id = ArtifactId::parse(&value).unwrap();
        assert_eq!(id.as_str(), value);
        assert_eq!(id.to_string(), value);
    }

    #[test]
    fn invalid_identity_is_rejected() {
        let _ = ArtifactId::parse("sha256:deadbeef").unwrap_err();
        let _ = ArtifactId::parse(format!(
            "{ARTIFACT_ID_PREFIX}{}",
            "A".repeat(ARTIFACT_DIGEST_HEX_LENGTH)
        ))
        .unwrap_err();
        let _ = ArtifactId::parse("artifact-1").unwrap_err();
    }
}
