import type { AuthOrganizationId } from '@fissionplane/core/auth/types'
import type { SandboxSummary } from '@fissionplane/core/sandboxes/views'
import { Context, Effect } from 'effect'

export interface ListSandboxesRepositoryInput {
  readonly organizationId: AuthOrganizationId
}

export interface SandboxRepositoryPort {
  readonly list: (
    input: ListSandboxesRepositoryInput,
  ) => Effect.Effect<ReadonlyArray<SandboxSummary>>
}

export class SandboxRepository extends Context.Tag(
  '@fissionplane/api/SandboxRepository',
)<SandboxRepository, SandboxRepositoryPort>() {}
