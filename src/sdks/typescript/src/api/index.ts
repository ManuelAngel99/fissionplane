import createClient, { type Client } from 'openapi-fetch'

import { errorFromResponse } from '../errors'
import {
  createHttpFetch,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type RequestDefaults,
} from '../http'
import { defaultHeaders } from './metadata'
import type { paths } from './schema.gen'

export interface ConnectionConfig extends RequestDefaults {
  /** Organisation API key, sent as `X-API-Key`. */
  apiKey?: string
  /** OIDC bearer token; used when no API key is given. */
  accessToken?: string
  /** Control-plane base URL. */
  baseUrl: string
  /** Custom fetch implementation (tests, non-Node runtimes). */
  fetch?: typeof globalThis.fetch
}

export type ApiClient = Client<paths>

/**
 * Creates the typed control-plane client.
 *
 * Every request carries the SDK's `User-Agent` and aborts once
 * `requestTimeoutMs` elapses; headers passed on a call win over both
 * the credential headers and the SDK's own.
 *
 * @param config Connection and authentication settings.
 * @returns A client whose operations are derived from the OpenAPI schema.
 */
export function createApiClient(config: ConnectionConfig): ApiClient {
  const headers: Record<string, string> = { ...defaultHeaders }
  if (config.apiKey !== undefined) {
    headers['X-API-Key'] = config.apiKey
  } else if (config.accessToken !== undefined) {
    headers['Authorization'] = `Bearer ${config.accessToken}`
  }

  return createClient<paths>({
    baseUrl: config.baseUrl,
    headers,
    fetch: createHttpFetch(
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      config.fetch,
    ),
  })
}

/**
 * Returns response data or throws the SDK error for a failed response.
 *
 * @param result The result returned by `openapi-fetch`.
 * @returns The successful response body.
 * @throws {FissionPlaneError} When the response is not successful.
 */
export function unwrap<T>(result: {
  data?: T
  error?: unknown
  response: Response
}): T {
  if (result.error !== undefined || !result.response.ok) {
    throw errorFromResponse(result.response.status, result.error)
  }
  // 204-shaped operations produce no body; T is void for those.
  return result.data as T
}
