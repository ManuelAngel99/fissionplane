import {
  domainErrorPayload,
  domainErrorResponse,
} from '@fissionplane/api/http/error-response'
import {
  AUTHENTICATED_MEMBER_HEADERS,
  withAuthenticatedMember,
  withoutAuthenticatedMember,
} from '@fissionplane/api/modules/authorization/infrastructure/http/authenticated-member'
import { createGuardedRouteMatcher } from '@fissionplane/api/modules/authorization/infrastructure/http/authenticated-routes'
import { ConsoleApiLive } from '@fissionplane/api/composition/console'
import { AuthenticatedMemberSchema } from '@fissionplane/core/auth/models'
import { ConsoleApi } from '@fissionplane/core/backend-api/definition'
import { OrganizationAuthentication } from '@fissionplane/core/backend-api/middlewares/authentication'
import {
  InternalError,
  UnauthenticatedError,
} from '@fissionplane/core/ddd/base-error'
import { ActiveOrganizationRequiredError } from '@fissionplane/core/organizations/errors'
import { HttpApiBuilder, HttpServer } from '@effect/platform'
import { Layer, Schema } from 'effect'
import { afterAll, describe, expect, it } from 'vitest'

const developer = Schema.decodeUnknownSync(AuthenticatedMemberSchema)({
  organizationId: 'auth-org-1',
  role: 'developer',
  userId: 'user-1',
})

const consoleRequest = (path: string, headers?: Record<string, string>) =>
  new Request(`http://console.test${path}`, { headers })

const consoleHandler = HttpApiBuilder.toWebHandler(
  Layer.mergeAll(ConsoleApiLive, HttpServer.layerContext),
)

afterAll(() => consoleHandler.dispose())

describe('trusted subject headers', () => {
  it('overwrites anything the caller supplied', () => {
    const forged = consoleRequest('/api/sandboxes', {
      [AUTHENTICATED_MEMBER_HEADERS.organizationRole]: 'owner',
      [AUTHENTICATED_MEMBER_HEADERS.userId]: 'attacker',
    })

    const trusted = withAuthenticatedMember(forged, developer)

    expect(trusted.headers.get(AUTHENTICATED_MEMBER_HEADERS.userId)).toBe(
      'user-1',
    )
    expect(
      trusted.headers.get(AUTHENTICATED_MEMBER_HEADERS.organizationRole),
    ).toBe('developer')
  })

  it('strips every subject header from an ungated request', () => {
    const forged = consoleRequest('/api/health', {
      [AUTHENTICATED_MEMBER_HEADERS.organizationId]: 'auth-org-9',
      [AUTHENTICATED_MEMBER_HEADERS.organizationRole]: 'owner',
      [AUTHENTICATED_MEMBER_HEADERS.userId]: 'attacker',
    })

    const stripped = withoutAuthenticatedMember(forged)

    for (const header of Object.values(AUTHENTICATED_MEMBER_HEADERS)) {
      expect(stripped.headers.has(header)).toBe(false)
    }
  })
})

describe('composed console handler', () => {
  it('serves the liveness probe without a subject', async () => {
    const response = await consoleHandler.handler(consoleRequest('/api/health'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      service: 'console-api',
      status: 'ok',
    })
  })

  it('runs a guarded handler with the subject the host wrote', async () => {
    const response = await consoleHandler.handler(
      withAuthenticatedMember(consoleRequest('/api/sandboxes'), developer),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([])
  })

  it('fails closed with the published 401 body when no subject arrives', async () => {
    const response = await consoleHandler.handler(
      consoleRequest('/api/sandboxes'),
    )

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      _tag: 'UnauthenticatedError',
      code: 'UNAUTHENTICATED',
      message: 'You are not authenticated',
    })
  })

  it('rejects a role that is not in the organization matrix', async () => {
    const response = await consoleHandler.handler(
      consoleRequest('/api/sandboxes', {
        [AUTHENTICATED_MEMBER_HEADERS.organizationId]: 'auth-org-1',
        [AUTHENTICATED_MEMBER_HEADERS.organizationRole]: 'superadmin',
        [AUTHENTICATED_MEMBER_HEADERS.userId]: 'user-1',
      }),
    )

    expect(response.status).toBe(401)
  })
})

describe('gate derived from the published contract', () => {
  const requiresMember = createGuardedRouteMatcher(
    ConsoleApi,
    OrganizationAuthentication,
  )

  it('gates only the routes that declare the middleware', () => {
    expect(requiresMember(consoleRequest('/api/sandboxes'))).toBe(true)
    expect(requiresMember(consoleRequest('/api/health'))).toBe(false)
  })

  it('ignores methods and paths outside the contract', () => {
    expect(
      requiresMember(
        new Request('http://console.test/api/sandboxes', { method: 'POST' }),
      ),
    ).toBe(false)
    expect(requiresMember(consoleRequest('/api/sandboxes/extra'))).toBe(false)
    expect(requiresMember(consoleRequest('/api/auth/session'))).toBe(false)
  })
})

describe('pre-Effect error responses', () => {
  it('serializes the same body and status the contract publishes', () => {
    const payload = domainErrorPayload(
      ActiveOrganizationRequiredError,
      new ActiveOrganizationRequiredError({}),
    )

    expect(payload.status).toBe(403)
    expect(JSON.parse(payload.body)).toEqual({
      _tag: 'ActiveOrganizationRequiredError',
      code: 'ACTIVE_ORGANIZATION_REQUIRED',
      message: 'Select an active organization before calling this API',
    })
  })

  it('returns JSON responses a generated client can decode', async () => {
    const response = domainErrorResponse(
      UnauthenticatedError,
      new UnauthenticatedError({}),
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual({
      _tag: 'UnauthenticatedError',
      code: 'UNAUTHENTICATED',
      message: 'You are not authenticated',
    })
  })

  it('never leaks detail in the defect payload the host writes', () => {
    const payload = domainErrorPayload(InternalError, new InternalError({}))

    expect(payload.status).toBe(500)
    expect(JSON.parse(payload.body)).toEqual({
      _tag: 'InternalError',
      code: 'INTERNAL',
      message: 'Internal server error',
    })
  })
})
