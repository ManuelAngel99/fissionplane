import { AUTHENTICATED_MEMBER_HEADERS } from '@fissionplane/api/modules/authorization/infrastructure/http/authenticated-member'
import { AuthenticatedMemberSchema } from '@fissionplane/core/auth/models'
import { OrganizationAuthentication } from '@fissionplane/core/backend-api/middlewares/authentication'
import { UnauthenticatedError } from '@fissionplane/core/ddd/base-error'
import { HttpServerRequest } from '@effect/platform'
import { Effect, Layer, Schema } from 'effect'

/**
 * Decodes the trusted internal headers written by the Better Auth host.
 *
 * A request that reaches a guarded endpoint without them never passed the
 * host's session gate, so it is unauthenticated rather than a server fault.
 */
export const OrganizationAuthenticationLive = Layer.succeed(
  OrganizationAuthentication,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    return yield* Schema.decodeUnknown(AuthenticatedMemberSchema)({
      organizationId:
        request.headers[AUTHENTICATED_MEMBER_HEADERS.organizationId],
      role: request.headers[AUTHENTICATED_MEMBER_HEADERS.organizationRole],
      userId: request.headers[AUTHENTICATED_MEMBER_HEADERS.userId],
    }).pipe(Effect.mapError(() => new UnauthenticatedError({})))
  }),
)
