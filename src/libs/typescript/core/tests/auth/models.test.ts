import { AuthenticatedMemberSchema } from '@fissionplane/core/auth/models'
import {
  AUTH_ORGANIZATION_ID_MAX_LENGTH,
  AuthOrganizationIdSchema,
} from '@fissionplane/core/auth/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decodeOrganizationId = Schema.decodeUnknownEither(
  AuthOrganizationIdSchema,
)
const decodeMember = Schema.decodeUnknownEither(AuthenticatedMemberSchema)

describe('Better Auth subject', () => {
  it('accepts external organization ids without NanoID rules', () => {
    expect(Either.isRight(decodeOrganizationId('org_external-123'))).toBe(true)
    expect(Either.isLeft(decodeOrganizationId(''))).toBe(true)
    expect(
      Either.isLeft(
        decodeOrganizationId('o'.repeat(AUTH_ORGANIZATION_ID_MAX_LENGTH + 1)),
      ),
    ).toBe(true)
  })

  it('decodes a trusted request subject', () => {
    const member = decodeMember({
      organizationId: 'auth-org-1',
      role: 'developer',
      userId: 'user-1',
    })

    expect(Either.isRight(member)).toBe(true)
  })

  it('rejects roles outside the organization role matrix', () => {
    expect(
      Either.isLeft(
        decodeMember({
          organizationId: 'auth-org-1',
          role: 'superadmin',
          userId: 'user-1',
        }),
      ),
    ).toBe(true)
  })

  it('rejects a subject that is missing its organization scope', () => {
    expect(
      Either.isLeft(decodeMember({ role: 'viewer', userId: 'user-1' })),
    ).toBe(true)
  })
})
