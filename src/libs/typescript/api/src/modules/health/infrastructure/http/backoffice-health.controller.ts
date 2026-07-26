import { GetHealthUseCase } from '@fissionplane/api/modules/health/application/get-health/get-health.use-case'
import { BackofficeApi } from '@fissionplane/core/backend-api/definition'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

export const BackofficeHealthControllerLive = HttpApiBuilder.group(
  BackofficeApi,
  'operations',
  Effect.fn(function* (handlers) {
    const getHealth = yield* GetHealthUseCase

    return handlers.handle('health', () =>
      getHealth.execute({ service: 'backoffice' }),
    )
  }),
)
