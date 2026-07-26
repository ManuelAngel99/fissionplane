import {
  generateTemplateBuildId,
  generateTemplateId,
  TEMPLATE_ALIAS_MAX_LENGTH,
  TemplateAliasSchema,
  TemplateBuildIdSchema,
  TemplateIdSchema,
} from '@fissionplane/core/templates/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decodeTemplateId = Schema.decodeUnknownEither(TemplateIdSchema)
const decodeBuildId = Schema.decodeUnknownEither(TemplateBuildIdSchema)
const decodeAlias = Schema.decodeUnknownEither(TemplateAliasSchema)

describe('template value objects', () => {
  it('generates canonical template and build ids', () => {
    expect(Either.isRight(decodeTemplateId(generateTemplateId()))).toBe(true)
    expect(Either.isRight(decodeBuildId(generateTemplateBuildId()))).toBe(true)
  })

  it('validates DNS-safe template aliases', () => {
    expect(Either.isRight(decodeAlias('node-24'))).toBe(true)
    expect(Either.isLeft(decodeAlias('UPPERCASE'))).toBe(true)
    expect(
      Either.isLeft(decodeAlias('x'.repeat(TEMPLATE_ALIAS_MAX_LENGTH + 1))),
    ).toBe(true)
  })
})
