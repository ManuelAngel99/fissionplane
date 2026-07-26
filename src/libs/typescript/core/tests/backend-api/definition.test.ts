import {
  BackofficeApi,
  ConsoleApi,
} from '@fissionplane/core/backend-api/definition'
import { OrganizationAuthentication } from '@fissionplane/core/backend-api/middlewares/authentication'
import * as HttpApi from '@effect/platform/HttpApi'
import type * as HttpApiGroup from '@effect/platform/HttpApiGroup'
import { describe, expect, it } from 'vitest'

interface EndpointRecord {
  readonly errorStatuses: ReadonlyArray<number>
  readonly middleware: ReadonlyArray<string>
  readonly route: string
}

const endpointsOf = <
  Id extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  E,
  R,
>(
  api: HttpApi.HttpApi<Id, Groups, E, R>,
): ReadonlyArray<EndpointRecord> => {
  const endpoints: Array<EndpointRecord> = []
  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, errors, group, middleware }) => {
      endpoints.push({
        errorStatuses: [...errors.keys()].toSorted((a, b) => a - b),
        middleware: [...middleware].map((tag) => tag.key),
        route: `${group.identifier}.${endpoint.name} ${endpoint.method} ${endpoint.path}`,
      })
    },
  })
  return endpoints
}

describe('console API contract', () => {
  const endpoints = endpointsOf(ConsoleApi)

  it('keeps the published routes under the /api prefix', () => {
    expect(endpoints.map((endpoint) => endpoint.route)).toEqual([
      'system.health GET /api/health',
      'sandboxes.list GET /api/sandboxes',
    ])
  })

  it('gates sandbox reads behind authentication and typed 403s', () => {
    const sandboxes = endpoints.find((endpoint) =>
      endpoint.route.startsWith('sandboxes.list'),
    )

    expect(sandboxes?.middleware).toEqual([OrganizationAuthentication.key])
    expect(sandboxes?.errorStatuses).toContain(401)
    expect(sandboxes?.errorStatuses).toContain(403)
  })

  it('leaves the liveness probe free of tenant middleware and 401s', () => {
    const system = endpoints.find((endpoint) =>
      endpoint.route.startsWith('system.health'),
    )

    expect(system?.middleware).toEqual([])
    expect(system?.errorStatuses).not.toContain(401)
  })

  it('lets clients decode escaped defects as a typed 500', () => {
    for (const endpoint of endpoints) {
      expect(endpoint.errorStatuses).toContain(500)
    }
  })
})

describe('backoffice API contract', () => {
  const endpoints = endpointsOf(BackofficeApi)

  it('exposes only the operator surface and never tenant groups', () => {
    expect(endpoints.map((endpoint) => endpoint.route)).toEqual([
      'operations.health GET /api/health',
    ])
  })

  it('declares the operator gate failures the host emits before Effect', () => {
    // 400 is the framework's own request-decode failure.
    expect(endpoints[0]?.errorStatuses).toEqual([400, 401, 403, 500])
  })

  it('never carries the tenant authentication middleware', () => {
    expect(endpoints.flatMap((endpoint) => endpoint.middleware)).toEqual([])
  })
})
