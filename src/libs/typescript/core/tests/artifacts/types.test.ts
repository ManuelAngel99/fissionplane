import {
  ARTIFACT_DIGEST_HEX_LENGTH,
  ARTIFACT_ID_LENGTH,
  ARTIFACT_ID_PREFIX,
  ArtifactIdSchema,
} from '@fissionplane/core/artifacts/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decode = Schema.decodeUnknownEither(ArtifactIdSchema)
const digest = (character: string) =>
  `${ARTIFACT_ID_PREFIX}${character.repeat(ARTIFACT_DIGEST_HEX_LENGTH)}`

describe('content-addressed artifact ids', () => {
  it('accepts a lowercase sha256 digest of the exact length', () => {
    const artifactId = digest('a')

    expect(artifactId).toHaveLength(ARTIFACT_ID_LENGTH)
    expect(Either.isRight(decode(artifactId))).toBe(true)
  })

  it('rejects truncated, uppercase, unprefixed, and non-hex digests', () => {
    expect(Either.isLeft(decode(`${ARTIFACT_ID_PREFIX}deadbeef`))).toBe(true)
    expect(Either.isLeft(decode(digest('A')))).toBe(true)
    expect(Either.isLeft(decode(digest('g')))).toBe(true)
    expect(Either.isLeft(decode('a'.repeat(ARTIFACT_DIGEST_HEX_LENGTH)))).toBe(
      true,
    )
    expect(
      Either.isLeft(decode(`sha512:${'a'.repeat(ARTIFACT_DIGEST_HEX_LENGTH)}`)),
    ).toBe(true)
  })
})
