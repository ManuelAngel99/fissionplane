import { BackofficeApi } from '@fissionplane/core/backend-api/definition'
import { queryOptions } from '@tanstack/react-query'
import * as FetchHttpClient from '@effect/platform/FetchHttpClient'
import * as HttpApiClient from '@effect/platform/HttpApiClient'
import * as Effect from 'effect/Effect'

const client = HttpApiClient.make(BackofficeApi, {
  baseUrl: window.location.origin,
})

export const healthQuery = queryOptions({
  queryFn: () =>
    Effect.runPromise(
      Effect.flatMap(client, (api) => api.operations.health()).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    ),
  queryKey: ['backoffice', 'health'],
})
