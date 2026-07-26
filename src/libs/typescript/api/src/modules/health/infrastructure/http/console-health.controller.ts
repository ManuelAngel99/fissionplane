import { GetHealthUseCase } from '@fissionplane/api/modules/health/application/get-health/get-health.use-case'
import { ConsoleApi } from '@fissionplane/core/backend-api/definition'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

export const ConsoleHealthControllerLive = HttpApiBuilder.group(
  ConsoleApi,
  'system',
  Effect.fn(function* (handlers) {
    const getHealth = yield* GetHealthUseCase

    return handlers.handle('health', () =>
      getHealth.execute({ service: 'console-api' }),
    )
  }),
)
