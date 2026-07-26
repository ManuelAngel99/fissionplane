import { auth } from '@fissionplane/backoffice-api/auth'
import { config } from '@fissionplane/backoffice-api/config'
import { BackofficeApiLive } from '@fissionplane/api/composition/backoffice'
import { domainErrorResponse } from '@fissionplane/api/http/error-response'
import { createNodeServer } from '@fissionplane/api/http/node-server'
import { withoutAuthenticatedMember } from '@fissionplane/api/modules/authorization/infrastructure/http/authenticated-member'
import {
  UnauthenticatedError,
  UnauthorizedError,
} from '@fissionplane/core/ddd/base-error'
import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Layer } from 'effect'

const api = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(BackofficeApiLive, HttpServer.layerContext),
)

export const server = createNodeServer({
  api,
  auth: (request) => auth.handler(request),
  // The operator gate covers the whole surface, so `BackofficeApi` declares
  // both failures at its root. Tenant subject headers are stripped because the
  // backoffice is a separate trust domain that never carries them.
  authorizeApi: async (incoming) => {
    const request = withoutAuthenticatedMember(incoming)
    const session = await auth.api.getSession({ headers: request.headers })
    if (session === null) {
      return domainErrorResponse(
        UnauthenticatedError,
        new UnauthenticatedError({}),
      )
    }
    return session.user.role === 'admin'
      ? request
      : domainErrorResponse(UnauthorizedError, new UnauthorizedError({}))
  },
  name: 'backoffice',
  port: config.port,
})
