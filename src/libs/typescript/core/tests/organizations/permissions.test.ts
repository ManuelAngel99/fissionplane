import {
  hasOrganizationPermission,
  organizationRoles,
  roleStatements,
  statements,
} from '@fissionplane/core/organizations/permissions'
import {
  OrganizationPermissionSchema,
  OrganizationRoleSchema,
} from '@fissionplane/core/organizations/types'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const permissionsOf = (
  grants: Readonly<Record<string, ReadonlyArray<string>>>,
): ReadonlyArray<string> =>
  Object.entries(grants).flatMap(([resource, actions]) =>
    actions.map((action) => `${resource}:${action}`),
  )

describe('organization permissions', () => {
  it('keeps viewer permissions read-only', () => {
    expect(hasOrganizationPermission('viewer', 'sandbox:read')).toBe(true)
    expect(hasOrganizationPermission('viewer', 'sandbox:create')).toBe(false)
    expect(hasOrganizationPermission('viewer', 'billing:read')).toBe(true)
    expect(hasOrganizationPermission('viewer', 'billing:manage')).toBe(false)
  })

  it('allows developers to operate sandboxes without managing billing', () => {
    expect(hasOrganizationPermission('developer', 'sandbox:create')).toBe(true)
    expect(hasOrganizationPermission('developer', 'sandbox:terminate')).toBe(
      true,
    )
    expect(hasOrganizationPermission('developer', 'billing:read')).toBe(false)
  })

  it('reserves organization deletion for owners', () => {
    expect(hasOrganizationPermission('owner', 'organization:delete')).toBe(true)
    expect(hasOrganizationPermission('admin', 'organization:delete')).toBe(
      false,
    )
  })

  it('grants owners every permission the catalog can express', () => {
    for (const permission of OrganizationPermissionSchema.literals) {
      expect(hasOrganizationPermission('owner', permission)).toBe(true)
    }
  })

  it('uses the same grants in Better Auth and domain checks', () => {
    expect(
      organizationRoles.admin.authorize({
        sandbox: ['terminate'],
      }).success,
    ).toBe(true)
    expect(
      organizationRoles.viewer.authorize({
        sandbox: ['terminate'],
      }).success,
    ).toBe(false)
  })

  it('covers every role in both the schema and the Better Auth role map', () => {
    const roles = Object.keys(roleStatements)

    expect(new Set(Object.keys(organizationRoles))).toEqual(new Set(roles))
    expect(new Set(OrganizationRoleSchema.literals)).toEqual(new Set(roles))
    for (const role of roles) {
      expect(Schema.is(OrganizationRoleSchema)(role)).toBe(true)
    }
  })

  it('keeps the typed catalog and the Better Auth statements identical', () => {
    expect(new Set(permissionsOf(statements))).toEqual(
      new Set(OrganizationPermissionSchema.literals),
    )
  })

  it('never grants a role something outside the statements', () => {
    const grantable = new Set(permissionsOf(statements))

    for (const grants of Object.values(roleStatements)) {
      for (const permission of permissionsOf(grants)) {
        expect(grantable.has(permission)).toBe(true)
      }
    }
  })
})
