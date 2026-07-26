import { displayNameSchema } from '@fissionplane/core/shared/names'
import * as Schema from 'effect/Schema'

export const USER_ID_MIN_LENGTH = 1
export const USER_ID_MAX_LENGTH = 255
export const USER_DISPLAY_NAME_MIN_LENGTH = 1
export const USER_DISPLAY_NAME_MAX_LENGTH = 80

/**
 * Better Auth owns the user identifier format, so this is a bounded external
 * string rather than a canonical FissionPlane NanoID.
 */
export const UserIdSchema = Schema.String.pipe(
  Schema.minLength(USER_ID_MIN_LENGTH),
  Schema.maxLength(USER_ID_MAX_LENGTH),
  Schema.brand('UserId'),
).annotations({
  identifier: 'UserId',
  title: 'User ID',
  description: `Better Auth-owned user identifier, ${USER_ID_MIN_LENGTH}–${USER_ID_MAX_LENGTH} characters.`,
})
export type UserId = typeof UserIdSchema.Type

export const UserDisplayNameSchema = displayNameSchema(
  USER_DISPLAY_NAME_MIN_LENGTH,
  USER_DISPLAY_NAME_MAX_LENGTH,
)
  .pipe(Schema.brand('UserDisplayName'))
  .annotations({
    identifier: 'UserDisplayName',
    title: 'User display name',
    description: `User display name, ${USER_DISPLAY_NAME_MIN_LENGTH}–${USER_DISPLAY_NAME_MAX_LENGTH} characters, without padding or control characters.`,
  })
export type UserDisplayName = typeof UserDisplayNameSchema.Type
