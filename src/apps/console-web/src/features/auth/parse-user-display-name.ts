import {
  USER_DISPLAY_NAME_MAX_LENGTH,
  USER_DISPLAY_NAME_MIN_LENGTH,
  UserDisplayNameSchema,
  type UserDisplayName,
} from '@fissionplane/core/users/types'

export type UserDisplayNameResult =
  | {
      readonly valid: true
      readonly value: UserDisplayName
    }
  | {
      readonly message: string
      readonly valid: false
    }

export const parseUserDisplayName = (input: string): UserDisplayNameResult => {
  const normalized = input.trim()
  if (normalized.length < USER_DISPLAY_NAME_MIN_LENGTH) {
    return { message: 'Name is required', valid: false }
  }
  if (normalized.length > USER_DISPLAY_NAME_MAX_LENGTH) {
    return {
      message: `Name must be ${USER_DISPLAY_NAME_MAX_LENGTH} characters or fewer`,
      valid: false,
    }
  }

  try {
    return { valid: true, value: UserDisplayNameSchema.make(normalized) }
  } catch {
    return {
      message: 'Name contains unsupported characters',
      valid: false,
    }
  }
}
