import {
  canonicalIdSchema,
  generateNanoId,
} from '@fissionplane/core/shared/identifiers'
import {
  displayNameSchema,
  dnsLabelSchema,
} from '@fissionplane/core/shared/names'
import * as Schema from 'effect/Schema'

export const ORGANIZATION_NAME_MIN_LENGTH = 1
export const ORGANIZATION_NAME_MAX_LENGTH = 100
export const ORGANIZATION_SLUG_MIN_LENGTH = 1
export const ORGANIZATION_SLUG_MAX_LENGTH = 63

export const OrganizationIdSchema = canonicalIdSchema(
  'OrganizationId',
  'Canonical identifier of an organization in the Rust control-plane catalog.',
)
export type OrganizationId = typeof OrganizationIdSchema.Type

export const OrganizationNameSchema = displayNameSchema(
  ORGANIZATION_NAME_MIN_LENGTH,
  ORGANIZATION_NAME_MAX_LENGTH,
)
  .pipe(Schema.brand('OrganizationName'))
  .annotations({
    identifier: 'OrganizationName',
    title: 'Organization name',
    description: `Organization display name, ${ORGANIZATION_NAME_MIN_LENGTH}–${ORGANIZATION_NAME_MAX_LENGTH} characters, without padding or control characters.`,
  })
export type OrganizationName = typeof OrganizationNameSchema.Type

export const OrganizationSlugSchema = dnsLabelSchema(
  ORGANIZATION_SLUG_MIN_LENGTH,
  ORGANIZATION_SLUG_MAX_LENGTH,
)
  .pipe(Schema.brand('OrganizationSlug'))
  .annotations({
    identifier: 'OrganizationSlug',
    title: 'Organization slug',
    description: `DNS-label-compatible organization slug, at most ${ORGANIZATION_SLUG_MAX_LENGTH} characters.`,
  })
export type OrganizationSlug = typeof OrganizationSlugSchema.Type

/**
 * Membership roles, declared here rather than beside the permission matrix so
 * `@fissionplane/core/organizations/permissions` stays free of Effect and never
 * pulls the schema runtime into a Better Auth client bundle.
 */
export const OrganizationRoleSchema = Schema.Literal(
  'owner',
  'admin',
  'developer',
  'viewer',
).annotations({
  identifier: 'OrganizationRole',
  title: 'Organization role',
  description: 'Membership role a user holds inside one tenant organization.',
})
export type OrganizationRole = typeof OrganizationRoleSchema.Type

/** Wire-level catalog of the grants `roleStatements` distributes to roles. */
export const OrganizationPermissionSchema = Schema.Literal(
  'organization:update',
  'organization:delete',
  'member:create',
  'member:update',
  'member:delete',
  'invitation:create',
  'invitation:cancel',
  'sandbox:create',
  'sandbox:read',
  'sandbox:pause',
  'sandbox:resume',
  'sandbox:terminate',
  'template:create',
  'template:read',
  'template:delete',
  'apiKey:create',
  'apiKey:read',
  'apiKey:revoke',
  'billing:read',
  'billing:manage',
).annotations({
  identifier: 'OrganizationPermission',
  title: 'Organization permission',
  description:
    'A `resource:action` grant derived from the organization role statements.',
})
export type OrganizationPermission = typeof OrganizationPermissionSchema.Type

export const generateOrganizationId = (): OrganizationId =>
  OrganizationIdSchema.make(generateNanoId())
