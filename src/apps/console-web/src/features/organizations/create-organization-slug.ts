import {
  ORGANIZATION_SLUG_MAX_LENGTH,
  OrganizationSlugSchema,
  type OrganizationName,
  type OrganizationSlug,
} from '@fissionplane/core/organizations/types'
import {
  generateNanoId,
  NANO_ID_LENGTH,
} from '@fissionplane/core/shared/identifiers'

const SLUG_SEPARATOR_LENGTH = 1
export const ORGANIZATION_SLUG_PREFIX_MAX_LENGTH =
  ORGANIZATION_SLUG_MAX_LENGTH - NANO_ID_LENGTH - SLUG_SEPARATOR_LENGTH

export const createOrganizationSlug = (
  name: OrganizationName,
): OrganizationSlug => {
  const prefix =
    name
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/(^-|-$)/g, '')
      .slice(0, ORGANIZATION_SLUG_PREFIX_MAX_LENGTH) || 'organization'

  return OrganizationSlugSchema.make(`${prefix}-${generateNanoId()}`)
}
