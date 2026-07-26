import { HttpApi } from '@effect/platform'
import type { HttpApiGroup } from '@effect/platform'

/**
 * Escapes every RegExp metacharacter so a literal path segment matches itself.
 */
const escapeSegment = (segment: string): string =>
  segment.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

/** Turns an `HttpApi` path such as `/api/sandboxes/:id` into a matcher. */
const toPathPattern = (path: string): RegExp => {
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        return '[^/]+'
      }
      return segment === '*' ? '.*' : escapeSegment(segment)
    })
    .join('/')
  return new RegExp(`^${source}/?$`, 'u')
}

interface GuardedRoute {
  readonly method: string
  readonly path: RegExp
}

/**
 * Derives, from the contract itself, which requests a middleware guards.
 *
 * The host resolves the caller before Effect runs, so it needs to know which
 * routes require a subject. Reading that from the `HttpApi` keeps the gate and
 * the published contract from drifting: declaring the middleware on a new
 * group automatically extends the gate, and an endpoint that drops it stops
 * being gated.
 */
export const createGuardedRouteMatcher = <
  Id extends string,
  Groups extends HttpApiGroup.HttpApiGroup.Any,
  E,
  R,
>(
  api: HttpApi.HttpApi<Id, Groups, E, R>,
  middleware: { readonly key: string },
): ((request: Request) => boolean) => {
  const routes: Array<GuardedRoute> = []

  HttpApi.reflect(api, {
    onGroup: () => {},
    onEndpoint: ({ endpoint, middleware: endpointMiddleware }) => {
      for (const tag of endpointMiddleware) {
        if (tag.key === middleware.key) {
          routes.push({
            method: endpoint.method,
            path: toPathPattern(endpoint.path),
          })
        }
      }
    },
  })

  return (request) => {
    const { pathname } = new URL(request.url)
    return routes.some(
      (route) => route.method === request.method && route.path.test(pathname),
    )
  }
}
