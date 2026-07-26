import {
  ORGANIZATION_NAME_MAX_LENGTH,
  ORGANIZATION_NAME_MIN_LENGTH,
  OrganizationNameSchema,
  type OrganizationName,
} from '@fissionplane/core/organizations/types'

export type OrganizationNameResult =
  | {
      readonly valid: true
      readonly value: OrganizationName
    }
  | {
      readonly message: string
      readonly valid: false
    }

export const parseOrganizationName = (
  input: string,
): OrganizationNameResult => {
  const normalized = input.trim()
  if (normalized.length < ORGANIZATION_NAME_MIN_LENGTH) {
    return { message: 'Organization name is required', valid: false }
  }
  if (normalized.length > ORGANIZATION_NAME_MAX_LENGTH) {
    return {
      message: `Organization name must be ${ORGANIZATION_NAME_MAX_LENGTH} characters or fewer`,
      valid: false,
    }
  }

  try {
    return { valid: true, value: OrganizationNameSchema.make(normalized) }
  } catch {
    return {
      message: 'Organization name contains unsupported characters',
      valid: false,
    }
  }
}
