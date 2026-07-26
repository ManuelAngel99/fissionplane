import { ConsoleApi } from '@fissionplane/core/backend-api/definition'
import { queryOptions } from '@tanstack/react-query'
import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as HttpApiClient from '@effect/platform/HttpApiClient'
import * as Effect from 'effect/Effect'

const client = HttpApiClient.make(ConsoleApi, {
  baseUrl: window.location.origin,
})

export const sandboxesQuery = queryOptions({
  queryFn: () =>
    Effect.runPromise(
      Effect.flatMap(client, (api) => api.sandboxes.list()).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  queryKey: ['console', 'sandboxes'],
})
