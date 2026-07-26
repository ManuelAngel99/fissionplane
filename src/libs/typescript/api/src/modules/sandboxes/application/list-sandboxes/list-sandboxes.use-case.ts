import { OrganizationRbacService } from '@fissionplane/api/modules/authorization/domain/services/organization-rbac.service'
import type {
  ListSandboxesInput,
  ListSandboxesResult,
} from '@fissionplane/api/modules/sandboxes/application/list-sandboxes/list-sandboxes.dto'
import { SandboxRepository } from '@fissionplane/api/modules/sandboxes/domain/repositories/sandbox-repository'
import type { ForbiddenError } from '@fissionplane/core/organizations/errors'
import { Context, Effect, Layer } from 'effect'

export interface ListSandboxesUseCasePort {
  readonly execute: (
    input: ListSandboxesInput,
  ) => Effect.Effect<ListSandboxesResult, ForbiddenError>
}

export class ListSandboxesUseCase extends Context.Tag(
  '@fissionplane/api/ListSandboxesUseCase',
)<ListSandboxesUseCase, ListSandboxesUseCasePort>() {}

export const ListSandboxesUseCaseLive = Layer.effect(
  ListSandboxesUseCase,
  Effect.gen(function* () {
    const rbac = yield* OrganizationRbacService
    const repository = yield* SandboxRepository

    return {
      execute: ({ subject }) =>
        rbac
          .requirePermission({
            permission: 'sandbox:read',
            subject,
          })
          .pipe(
            Effect.andThen(() =>
              repository.list({ organizationId: subject.organizationId }),
            ),
          ),
    }
  }),
)
