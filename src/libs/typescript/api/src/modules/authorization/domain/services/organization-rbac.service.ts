import type { AuthenticatedMember } from '@fissionplane/core/auth/models'
import { ForbiddenError } from '@fissionplane/core/organizations/errors'
import { hasOrganizationPermission } from '@fissionplane/core/organizations/permissions'
import type { OrganizationPermission } from '@fissionplane/core/organizations/types'
import { Context, Effect, Layer } from 'effect'

export interface PermissionCheck {
  readonly permission: OrganizationPermission
  readonly subject: AuthenticatedMember
}

export interface OrganizationRbacServicePort {
  readonly hasPermission: (check: PermissionCheck) => Effect.Effect<boolean>
  readonly requirePermission: (
    check: PermissionCheck,
  ) => Effect.Effect<void, ForbiddenError>
}

export class OrganizationRbacService extends Context.Tag(
  '@fissionplane/api/OrganizationRbacService',
)<OrganizationRbacService, OrganizationRbacServicePort>() {}

export const OrganizationRbacServiceLive = Layer.succeed(
  OrganizationRbacService,
  {
    hasPermission: ({ permission, subject }) =>
      Effect.succeed(hasOrganizationPermission(subject.role, permission)),
    requirePermission: ({ permission, subject }) =>
      hasOrganizationPermission(subject.role, permission)
        ? Effect.void
        : Effect.fail(new ForbiddenError({ permission })),
  },
)
