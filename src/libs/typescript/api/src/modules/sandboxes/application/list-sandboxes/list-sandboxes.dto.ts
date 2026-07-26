import type { AuthenticatedMember } from '@fissionplane/core/auth/models'
import type { SandboxSummary } from '@fissionplane/core/sandboxes/views'

export interface ListSandboxesInput {
  readonly subject: AuthenticatedMember
}

export type ListSandboxesResult = ReadonlyArray<SandboxSummary>
