import {
  generateNanoId,
  NANO_ID_ALPHABET,
  NANO_ID_LENGTH,
  NANO_ID_PATTERN,
  NanoIdSchema,
} from '@fissionplane/core/shared/identifiers'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decode = Schema.decodeUnknownEither(NanoIdSchema)

describe('canonical NanoIDs', () => {
  it('generates unique ids over the exported alphabet and length', () => {
    const identifiers = Array.from({ length: 1_000 }, generateNanoId)

    expect(new Set(identifiers).size).toBe(identifiers.length)
    for (const identifier of identifiers) {
      expect(identifier).toHaveLength(NANO_ID_LENGTH)
      expect(identifier).toMatch(NANO_ID_PATTERN)
    }
    for (const character of new Set(identifiers.join(''))) {
      expect(NANO_ID_ALPHABET).toContain(character)
    }
  })

  it('keeps ~124 bits of entropy available to the generator', () => {
    const bits = NANO_ID_LENGTH * Math.log2(NANO_ID_ALPHABET.length)

    expect(new Set(NANO_ID_ALPHABET).size).toBe(NANO_ID_ALPHABET.length)
    expect(Math.floor(bits)).toBe(124)
  })

  it('rejects UUIDs, wrong lengths, and uppercase characters', () => {
    expect(Either.isLeft(decode('550e8400-e29b-41d4-a716-446655440000'))).toBe(
      true,
    )
    expect(Either.isLeft(decode('a'.repeat(NANO_ID_LENGTH - 1)))).toBe(true)
    expect(Either.isLeft(decode('a'.repeat(NANO_ID_LENGTH + 1)))).toBe(true)
    expect(Either.isLeft(decode('A'.repeat(NANO_ID_LENGTH)))).toBe(true)
    expect(Either.isLeft(decode('a-b'.repeat(8)))).toBe(true)
    expect(Either.isRight(decode('a'.repeat(NANO_ID_LENGTH)))).toBe(true)
  })
})
