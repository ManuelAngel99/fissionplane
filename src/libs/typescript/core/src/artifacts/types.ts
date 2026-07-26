import * as Schema from 'effect/Schema'

export const ARTIFACT_ID_PREFIX = 'sha256:'
export const ARTIFACT_DIGEST_HEX_LENGTH = 64
export const ARTIFACT_ID_LENGTH =
  ARTIFACT_ID_PREFIX.length + ARTIFACT_DIGEST_HEX_LENGTH
export const ARTIFACT_ID_PATTERN = new RegExp(
  `^${ARTIFACT_ID_PREFIX}[a-f0-9]{${ARTIFACT_DIGEST_HEX_LENGTH}}$`,
)

/**
 * Artifacts are content-addressed, so their identifier is the digest itself
 * rather than a generated canonical NanoID.
 */
const artifactId = Schema.String.pipe(
  Schema.pattern(ARTIFACT_ID_PATTERN),
  Schema.brand('ArtifactId'),
)

export const ArtifactIdSchema = artifactId.annotations({
  identifier: 'ArtifactId',
  title: 'Artifact ID',
  description: `Lowercase content digest of the form "${ARTIFACT_ID_PREFIX}<${ARTIFACT_DIGEST_HEX_LENGTH} hex characters>".`,
  examples: [
    artifactId.make(
      `${ARTIFACT_ID_PREFIX}${'0'.repeat(ARTIFACT_DIGEST_HEX_LENGTH)}`,
    ),
  ],
})
export type ArtifactId = typeof ArtifactIdSchema.Type
