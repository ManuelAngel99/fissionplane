import * as Schema from 'effect/Schema'

export const AUTH_ORGANIZATION_ID_MIN_LENGTH = 1
export const AUTH_ORGANIZATION_ID_MAX_LENGTH = 255

/**
 * Better Auth's organization identifier, distinct from the catalog-owned
 * `OrganizationId` in `@fissionplane/core/organizations/types`. It is a bounded
 * external string, never a canonical FissionPlane NanoID.
 */
export const AuthOrganizationIdSchema = Schema.String.pipe(
  Schema.minLength(AUTH_ORGANIZATION_ID_MIN_LENGTH),
  Schema.maxLength(AUTH_ORGANIZATION_ID_MAX_LENGTH),
  Schema.brand('AuthOrganizationId'),
).annotations({
  identifier: 'AuthOrganizationId',
  title: 'Better Auth organization ID',
  description: `Better Auth-owned organization identifier, ${AUTH_ORGANIZATION_ID_MIN_LENGTH}–${AUTH_ORGANIZATION_ID_MAX_LENGTH} characters.`,
})
export type AuthOrganizationId = typeof AuthOrganizationIdSchema.Type
