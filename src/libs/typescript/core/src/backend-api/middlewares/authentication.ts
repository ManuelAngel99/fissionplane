import type { AuthenticatedMember } from '@fissionplane/core/auth/models'
import {
  UnauthenticatedError,
  UnauthorizedError,
} from '@fissionplane/core/ddd/base-error'
import { ActiveOrganizationRequiredError } from '@fissionplane/core/organizations/errors'
import * as HttpApiMiddleware from '@effect/platform/HttpApiMiddleware'
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'

/**
 * Caller context provided by {@link OrganizationAuthentication}.
 *
 * Handlers read it with `yield* AuthenticatedMemberContext`. Because the tag is
 * removed from the handler's requirements only by the middleware, an endpoint
 * either declares authentication or does not compile.
 */
export class AuthenticatedMemberContext extends Context.Tag(
  '@fissionplane/core/AuthenticatedMemberContext',
)<AuthenticatedMemberContext, AuthenticatedMember>() {}

/**
 * Every way resolving the calling member can fail.
 *
 * The Better Auth host resolves the subject before Effect runs, so it emits
 * these bodies directly; the live middleware layer emits
 * {@link UnauthenticatedError} when the trusted headers are absent. Declaring
 * the full union keeps the generated client able to decode either source.
 */
export const OrganizationAuthenticationFailureSchema = Schema.Union(
  UnauthenticatedError,
  ActiveOrganizationRequiredError,
  UnauthorizedError,
)

/**
 * Tag-only contract for tenant authentication; client-safe by construction.
 *
 * The live layer lives in `@fissionplane/api` and reads the trusted internal
 * headers the Better Auth host writes after resolving the session. This module
 * must never import Better Auth server code or Node APIs.
 */
export class OrganizationAuthentication extends HttpApiMiddleware.Tag<OrganizationAuthentication>()(
  '@fissionplane/core/OrganizationAuthentication',
  {
    failure: OrganizationAuthenticationFailureSchema,
    provides: AuthenticatedMemberContext,
  },
) {}
