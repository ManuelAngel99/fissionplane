import { auth } from '@fissionplane/console-api/auth'
import { config } from '@fissionplane/console-api/config'
import { ConsoleApiLive } from '@fissionplane/api/composition/console'
import { domainErrorResponse } from '@fissionplane/api/http/error-response'
import { createNodeServer } from '@fissionplane/api/http/node-server'
import {
  withAuthenticatedMember,
  withoutAuthenticatedMember,
} from '@fissionplane/api/modules/authorization/infrastructure/http/authenticated-member'
import { createGuardedRouteMatcher } from '@fissionplane/api/modules/authorization/infrastructure/http/authenticated-routes'
import { AuthenticatedMemberSchema } from '@fissionplane/core/auth/models'
import { ConsoleApi } from '@fissionplane/core/backend-api/definition'
import { OrganizationAuthentication } from '@fissionplane/core/backend-api/middlewares/authentication'
import {
  UnauthenticatedError,
  UnauthorizedError,
} from '@fissionplane/core/ddd/base-error'
import { ActiveOrganizationRequiredError } from '@fissionplane/core/organizations/errors'
import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Either, Layer, Schema } from 'effect'

const api = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ConsoleApiLive, HttpServer.layerContext),
)

const requiresAuthenticatedMember = createGuardedRouteMatcher(
  ConsoleApi,
  OrganizationAuthentication,
)

const decodeMember = Schema.decodeUnknownEither(AuthenticatedMemberSchema)

/**
 * Resolves the caller once per request and hands Effect a trusted subject.
 *
 * Only routes that declare `OrganizationAuthentication` are gated, so the
 * unauthenticated liveness probe keeps working and the host never rejects a
 * request the published contract says is open. Subject headers are stripped
 * from every request first, so the middleware can only ever read what this
 * gate wrote.
 */
const resolveAuthenticatedMember = async (
  incoming: Request,
): Promise<Request | Response> => {
  const request = withoutAuthenticatedMember(incoming)
  if (!requiresAuthenticatedMember(request)) {
    return request
  }

  const session = await auth.api.getSession({ headers: request.headers })
  if (session === null) {
    return domainErrorResponse(
      UnauthenticatedError,
      new UnauthenticatedError({}),
    )
  }

  const organizationId = session.session.activeOrganizationId
  if (organizationId === null || organizationId === undefined) {
    return domainErrorResponse(
      ActiveOrganizationRequiredError,
      new ActiveOrganizationRequiredError({}),
    )
  }

  // Better Auth throws when the session's active organization has no matching
  // membership row; that is a barred caller, not a server fault.
  const member = await auth.api
    .getActiveMemberRole({
      headers: request.headers,
      query: { organizationId },
    })
    .catch(() => null)

  const subject = decodeMember({
    organizationId,
    role: member?.role,
    userId: session.user.id,
  })
  if (Either.isLeft(subject)) {
    return domainErrorResponse(UnauthorizedError, new UnauthorizedError({}))
  }

  return withAuthenticatedMember(request, subject.right)
}

export const server = createNodeServer({
  api,
  auth: (request) => auth.handler(request),
  authorizeApi: resolveAuthenticatedMember,
  name: 'console-api',
  port: config.port,
})
