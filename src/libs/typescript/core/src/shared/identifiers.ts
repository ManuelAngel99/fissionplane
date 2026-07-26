import * as Schema from 'effect/Schema'
import { customAlphabet } from 'nanoid'

export const NANO_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'
export const NANO_ID_LENGTH = 24
export const NANO_ID_PATTERN = new RegExp(
  `^[${NANO_ID_ALPHABET}]{${NANO_ID_LENGTH}}$`,
)

const nanoid = customAlphabet(NANO_ID_ALPHABET, NANO_ID_LENGTH)

export const NanoIdSchema = Schema.String.pipe(
  Schema.pattern(NANO_ID_PATTERN),
).annotations({
  identifier: 'NanoId',
  title: 'Canonical resource identifier',
  description: `Secure ${NANO_ID_LENGTH}-character lowercase-alphanumeric NanoID carrying roughly 124 bits of entropy.`,
  examples: ['q1w2e3r4t5y6u7i8o9p0a1s2'],
})
export type NanoId = typeof NanoIdSchema.Type

/**
 * Brand {@link NanoIdSchema} for one resource family.
 *
 * Every canonical FissionPlane identifier is built through this helper so all
 * of them share one alphabet, length, and entropy guarantee.
 */
export const canonicalIdSchema = <Brand extends string>(
  brand: Brand,
  description: string,
) =>
  NanoIdSchema.pipe(Schema.brand(brand)).annotations({
    identifier: brand,
    description,
  })

export const generateNanoId = (): NanoId => NanoIdSchema.make(nanoid())
