import { SandboxRepository } from '@fissionplane/api/modules/sandboxes/domain/repositories/sandbox-repository'
import { Effect, Layer } from 'effect'

export const EmptySandboxRepositoryLive = Layer.succeed(SandboxRepository, {
  list: () => Effect.succeed([]),
})
