import type {
  OrganizationPermission,
  OrganizationRole,
} from '@fissionplane/core/organizations/types'
import { createAccessControl, type Role } from 'better-auth/plugins/access'

/**
 * Every `resource:action` grant tenant authorization can express.
 *
 * `OrganizationPermissionSchema` is the wire-level catalog of the same grants;
 * `tests/organizations/permissions.test.ts` proves the two stay identical.
 */
export const statements = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  sandbox: ['create', 'read', 'pause', 'resume', 'terminate'],
  template: ['create', 'read', 'delete'],
  apiKey: ['create', 'read', 'revoke'],
  billing: ['read', 'manage'],
} as const

/** Grants a role may hold: a subset of {@link statements} for every resource. */
type RoleGrants = {
  readonly [Resource in keyof typeof statements]: ReadonlyArray<
    (typeof statements)[Resource][number]
  >
}

export const accessControl = createAccessControl(statements)

/**
 * Single source of truth for tenant authorization.
 *
 * Better Auth's organization plugin and the pure `hasOrganizationPermission`
 * check both read this matrix; never fork it. `satisfies` keeps every role in
 * `OrganizationRole` covered and every grant inside {@link statements}.
 */
export const roleStatements = {
  owner: statements,
  admin: {
    organization: ['update'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    sandbox: ['create', 'read', 'pause', 'resume', 'terminate'],
    template: ['create', 'read', 'delete'],
    apiKey: ['create', 'read', 'revoke'],
    billing: ['read'],
  },
  developer: {
    organization: [],
    member: [],
    invitation: [],
    sandbox: ['create', 'read', 'pause', 'resume', 'terminate'],
    template: ['create', 'read'],
    apiKey: ['create', 'read', 'revoke'],
    billing: [],
  },
  viewer: {
    organization: [],
    member: [],
    invitation: [],
    sandbox: ['read'],
    template: ['read'],
    apiKey: [],
    billing: ['read'],
  },
} as const satisfies Record<OrganizationRole, RoleGrants>

export const owner = accessControl.newRole(roleStatements.owner)
export const admin = accessControl.newRole(roleStatements.admin)
export const developer = accessControl.newRole(roleStatements.developer)
export const viewer = accessControl.newRole(roleStatements.viewer)

export const organizationRoles = {
  admin,
  developer,
  owner,
  viewer,
} satisfies Record<OrganizationRole, Role>

const permissionSetFromStatements = (grants: RoleGrants): ReadonlySet<string> =>
  new Set(
    Object.entries(grants).flatMap(([resource, actions]) =>
      actions.map((action) => `${resource}:${action}`),
    ),
  )

const rolePermissionSets: Record<OrganizationRole, ReadonlySet<string>> = {
  admin: permissionSetFromStatements(roleStatements.admin),
  developer: permissionSetFromStatements(roleStatements.developer),
  owner: permissionSetFromStatements(roleStatements.owner),
  viewer: permissionSetFromStatements(roleStatements.viewer),
}

export const hasOrganizationPermission = (
  role: OrganizationRole,
  permission: OrganizationPermission,
): boolean => rolePermissionSets[role].has(permission)
