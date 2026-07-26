import { DomainError } from '@fissionplane/core/ddd/base-error'
import { ErrorCode } from '@fissionplane/core/ddd/codes'
import { OrganizationPermissionSchema } from '@fissionplane/core/organizations/types'

/**
 * The caller's organization role does not grant the required permission.
 *
 * `permission` is part of the wire contract so clients can tell the user which
 * grant is missing. Maps to HTTP 403.
 */
export class ForbiddenError extends DomainError<ForbiddenError>()(
  'ForbiddenError',
  'FORBIDDEN',
  ErrorCode.UNAUTHORIZED.message,
  ErrorCode.UNAUTHORIZED.statusCode,
  { permission: OrganizationPermissionSchema },
) {}

/**
 * The session is valid but has no active organization, so no tenant scope can
 * be resolved. Maps to HTTP 403.
 */
export class ActiveOrganizationRequiredError extends DomainError<ActiveOrganizationRequiredError>()(
  'ActiveOrganizationRequiredError',
  'ACTIVE_ORGANIZATION_REQUIRED',
  'Select an active organization before calling this API',
  ErrorCode.UNAUTHORIZED.statusCode,
  {},
) {}
