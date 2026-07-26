import { AuthOrganizationIdSchema } from '@fissionplane/core/auth/types'
import { OrganizationRoleSchema } from '@fissionplane/core/organizations/types'
import { UserIdSchema } from '@fissionplane/core/users/types'
import * as Schema from 'effect/Schema'

/**
 * Per-request caller identity resolved from the Better Auth session.
 *
 * The HTTP host resolves it once and forwards it through trusted internal
 * headers; nothing in this struct may come from a browser-supplied payload.
 */
export const AuthenticatedMemberSchema = Schema.Struct({
  organizationId: AuthOrganizationIdSchema,
  role: OrganizationRoleSchema,
  userId: UserIdSchema,
}).annotations({
  identifier: 'AuthenticatedMember',
  title: 'Authenticated member',
  description:
    'Authenticated user together with the active organization and membership role.',
})
export type AuthenticatedMember = typeof AuthenticatedMemberSchema.Type
