import {
  AuthenticatedMemberContext,
  OrganizationAuthentication,
  OrganizationAuthenticationFailureSchema,
} from '@fissionplane/core/backend-api/middlewares/authentication'
import {
  UnauthenticatedError,
  UnauthorizedError,
} from '@fissionplane/core/ddd/base-error'
import { ActiveOrganizationRequiredError } from '@fissionplane/core/organizations/errors'
import * as HttpApiSchema from '@effect/platform/HttpApiSchema'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const failures = OrganizationAuthenticationFailureSchema.members

describe('organization authentication contract', () => {
  it('provides the caller through a tag handlers cannot fabricate', () => {
    expect(OrganizationAuthentication.provides).toBe(AuthenticatedMemberContext)
  })

  it('declares every failure the host or the live layer can emit', () => {
    expect(failures).toHaveLength(3)
    expect(failures).toContain(UnauthenticatedError)
    expect(failures).toContain(ActiveOrganizationRequiredError)
    expect(failures).toContain(UnauthorizedError)
  })

  it('maps the missing-session failure to 401 and the rest to 403', () => {
    expect(HttpApiSchema.getStatusError(UnauthenticatedError)).toBe(401)
    for (const failure of failures) {
      const status = HttpApiSchema.getStatusError(Schema.asSchema(failure))
      expect(failure === UnauthenticatedError ? 401 : 403).toBe(status)
    }
  })
})
