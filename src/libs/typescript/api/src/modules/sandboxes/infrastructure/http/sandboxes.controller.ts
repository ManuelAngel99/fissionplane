import { ListSandboxesUseCase } from '@fissionplane/api/modules/sandboxes/application/list-sandboxes/list-sandboxes.use-case'
import { AuthenticatedMemberContext } from '@fissionplane/core/backend-api/middlewares/authentication'
import { ConsoleApi } from '@fissionplane/core/backend-api/definition'
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'

export const SandboxesControllerLive = HttpApiBuilder.group(
  ConsoleApi,
  'sandboxes',
  Effect.fn(function* (handlers) {
    const listSandboxes = yield* ListSandboxesUseCase

    return handlers.handle(
      'list',
      Effect.fn(function* () {
        const subject = yield* AuthenticatedMemberContext
        return yield* listSandboxes.execute({ subject })
      }),
    )
  }),
)
