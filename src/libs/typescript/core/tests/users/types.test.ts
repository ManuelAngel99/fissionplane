import {
  USER_DISPLAY_NAME_MAX_LENGTH,
  USER_ID_MAX_LENGTH,
  UserDisplayNameSchema,
  UserIdSchema,
} from '@fissionplane/core/users/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decodeId = Schema.decodeUnknownEither(UserIdSchema)
const decodeName = Schema.decodeUnknownEither(UserDisplayNameSchema)

describe('user value objects', () => {
  it('accepts Better Auth-owned ids without imposing the NanoID format', () => {
    expect(Either.isRight(decodeId('better-auth-user_123'))).toBe(true)
    expect(
      Either.isRight(decodeId('550e8400-e29b-41d4-a716-446655440000')),
    ).toBe(true)
  })

  it('still bounds external ids', () => {
    expect(Either.isLeft(decodeId(''))).toBe(true)
    expect(Either.isLeft(decodeId('u'.repeat(USER_ID_MAX_LENGTH + 1)))).toBe(
      true,
    )
  })

  it('validates display names', () => {
    expect(Either.isRight(decodeName('Ada Lovelace'))).toBe(true)
    expect(
      Either.isLeft(decodeName('x'.repeat(USER_DISPLAY_NAME_MAX_LENGTH + 1))),
    ).toBe(true)
    expect(Either.isLeft(decodeName('Ada '))).toBe(true)
  })
})
