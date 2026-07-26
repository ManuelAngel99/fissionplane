import {
  ActiveOrganizationRequiredError,
  ForbiddenError,
} from '@fissionplane/core/organizations/errors'
import * as HttpApiSchema from '@effect/platform/HttpApiSchema'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

describe('organization errors', () => {
  it('serializes a permission denial with a stable machine-readable payload', () => {
    const error = new ForbiddenError({ permission: 'sandbox:create' })

    expect(error.permission).toBe('sandbox:create')
    expect(Schema.encodeSync(ForbiddenError)(error)).toEqual({
      _tag: 'ForbiddenError',
      code: 'FORBIDDEN',
      message: 'You are not authorized to perform this action',
      permission: 'sandbox:create',
    })
  })

  it('maps permission denials to HTTP 403', () => {
    expect(HttpApiSchema.getStatusError(ForbiddenError)).toBe(403)
    expect(HttpApiSchema.getStatusError(ActiveOrganizationRequiredError)).toBe(
      403,
    )
  })

  it('distinguishes a missing active organization from a permission denial', () => {
    expect(
      Schema.encodeSync(ActiveOrganizationRequiredError)(
        new ActiveOrganizationRequiredError({}),
      ),
    ).toEqual({
      _tag: 'ActiveOrganizationRequiredError',
      code: 'ACTIVE_ORGANIZATION_REQUIRED',
      message: 'Select an active organization before calling this API',
    })
  })
})
