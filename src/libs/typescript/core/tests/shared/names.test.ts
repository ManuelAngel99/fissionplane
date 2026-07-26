import {
  displayNameSchema,
  dnsLabelSchema,
  RESOURCE_DESCRIPTION_MAX_LENGTH,
  RESOURCE_DESCRIPTION_MIN_LENGTH,
  ResourceDescriptionSchema,
} from '@fissionplane/core/shared/names'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decodeDescription = Schema.decodeUnknownEither(ResourceDescriptionSchema)

// Arbitrary bounds: these two cases exercise the factories themselves, not a
// value object's published limits.
const SAMPLE_MIN_LENGTH = 1
const SAMPLE_MAX_LENGTH = 10

describe('shared name primitives', () => {
  it('rejects padding and control characters in display names', () => {
    const decode = Schema.decodeUnknownEither(
      displayNameSchema(SAMPLE_MIN_LENGTH, SAMPLE_MAX_LENGTH),
    )

    expect(
      Either.isRight(decode('Ada Lovelace'.slice(0, SAMPLE_MAX_LENGTH))),
    ).toBe(true)
    expect(Either.isLeft(decode('x'.repeat(SAMPLE_MAX_LENGTH + 1)))).toBe(true)
    expect(Either.isLeft(decode(' padded'))).toBe(true)
    expect(Either.isLeft(decode('padded '))).toBe(true)
    expect(Either.isLeft(decode('bad\nname'))).toBe(true)
    expect(Either.isLeft(decode(''))).toBe(true)
  })

  it('rejects uppercase and hyphen edges in DNS labels', () => {
    const decode = Schema.decodeUnknownEither(
      dnsLabelSchema(SAMPLE_MIN_LENGTH, SAMPLE_MAX_LENGTH),
    )

    expect(Either.isRight(decode('build-1'))).toBe(true)
    expect(Either.isLeft(decode('x'.repeat(SAMPLE_MAX_LENGTH + 1)))).toBe(true)
    expect(Either.isLeft(decode('UPPER'))).toBe(true)
    expect(Either.isLeft(decode('-lead'))).toBe(true)
    expect(Either.isLeft(decode('trail-'))).toBe(true)
  })

  it('bounds resource descriptions by the exported constants', () => {
    expect(
      Either.isRight(
        decodeDescription('x'.repeat(RESOURCE_DESCRIPTION_MIN_LENGTH)),
      ),
    ).toBe(true)
    expect(
      Either.isRight(
        decodeDescription('x'.repeat(RESOURCE_DESCRIPTION_MAX_LENGTH)),
      ),
    ).toBe(true)
    expect(
      Either.isLeft(
        decodeDescription('x'.repeat(RESOURCE_DESCRIPTION_MAX_LENGTH + 1)),
      ),
    ).toBe(true)
    expect(Either.isLeft(decodeDescription(''))).toBe(true)
  })
})
