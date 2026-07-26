import * as Schema from 'effect/Schema'

/** Rejects leading/trailing whitespace and any Unicode control character. */
export const DISPLAY_NAME_PATTERN = /^(?!\s)(?!.*\s$)[^\p{Cc}]+$/u

/** Lowercase DNS label: alphanumeric edges, optional inner hyphens. */
export const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

export const RESOURCE_DESCRIPTION_MIN_LENGTH = 1
export const RESOURCE_DESCRIPTION_MAX_LENGTH = 2_000

/** Human-readable label bounded by the caller's exported length constants. */
export const displayNameSchema = (minLength: number, maxLength: number) =>
  Schema.String.pipe(
    Schema.minLength(minLength),
    Schema.maxLength(maxLength),
    Schema.pattern(DISPLAY_NAME_PATTERN),
  )

/** DNS-label-compatible name bounded by the caller's exported constants. */
export const dnsLabelSchema = (minLength: number, maxLength: number) =>
  Schema.String.pipe(
    Schema.minLength(minLength),
    Schema.maxLength(maxLength),
    Schema.pattern(DNS_LABEL_PATTERN),
  )

export const ResourceDescriptionSchema = displayNameSchema(
  RESOURCE_DESCRIPTION_MIN_LENGTH,
  RESOURCE_DESCRIPTION_MAX_LENGTH,
)
  .pipe(Schema.brand('ResourceDescription'))
  .annotations({
    identifier: 'ResourceDescription',
    title: 'Resource description',
    description: `Optional operator-authored description shared by sandboxes and templates, capped at ${RESOURCE_DESCRIPTION_MAX_LENGTH} characters.`,
  })
export type ResourceDescription = typeof ResourceDescriptionSchema.Type
