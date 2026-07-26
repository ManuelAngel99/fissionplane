import {
  generateOrganizationId,
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
  OrganizationIdSchema,
  OrganizationNameSchema,
  OrganizationSlugSchema,
} from '@fissionplane/core/organizations/types'
import { NANO_ID_PATTERN } from '@fissionplane/core/shared/identifiers'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decodeId = Schema.decodeUnknownEither(OrganizationIdSchema)
const decodeName = Schema.decodeUnknownEither(OrganizationNameSchema)
const decodeSlug = Schema.decodeUnknownEither(OrganizationSlugSchema)

describe('organization value objects', () => {
  it('generates catalog ids that satisfy the canonical NanoID contract', () => {
    const id = generateOrganizationId()

    expect(id).toMatch(NANO_ID_PATTERN)
    expect(Either.isRight(decodeId(id))).toBe(true)
  })

  it('rejects identifiers from other formats', () => {
    expect(Either.isLeft(decodeId('org_01JVMKF6HQSJHRAAKAGD2RZ5WH'))).toBe(true)
    expect(
      Either.isLeft(decodeId('550e8400-e29b-41d4-a716-446655440000')),
    ).toBe(true)
  })

  it('validates organization names', () => {
    expect(Either.isRight(decodeName('Analytical Engines'))).toBe(true)
    expect(
      Either.isRight(decodeName('x'.repeat(ORGANIZATION_NAME_MAX_LENGTH))),
    ).toBe(true)
    expect(
      Either.isLeft(decodeName('x'.repeat(ORGANIZATION_NAME_MAX_LENGTH + 1))),
    ).toBe(true)
    expect(Either.isLeft(decodeName('  Padded'))).toBe(true)
    expect(Either.isLeft(decodeName(''))).toBe(true)
  })

  it('validates DNS-safe organization slugs', () => {
    expect(Either.isRight(decodeSlug('acme-platform'))).toBe(true)
    expect(
      Either.isLeft(decodeSlug('x'.repeat(ORGANIZATION_SLUG_MAX_LENGTH + 1))),
    ).toBe(true)
    expect(Either.isLeft(decodeSlug('Acme'))).toBe(true)
    expect(Either.isLeft(decodeSlug('-acme'))).toBe(true)
  })
})
