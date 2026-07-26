import {
  canonicalIdSchema,
  generateNanoId,
} from '@fissionplane/core/shared/identifiers'
import { dnsLabelSchema } from '@fissionplane/core/shared/names'
import * as Schema from 'effect/Schema'

export const TEMPLATE_ALIAS_MIN_LENGTH = 1
export const TEMPLATE_ALIAS_MAX_LENGTH = 63

export const TemplateIdSchema = canonicalIdSchema(
  'TemplateId',
  'Canonical identifier of a template in the Rust control-plane catalog.',
)
export type TemplateId = typeof TemplateIdSchema.Type

export const TemplateBuildIdSchema = canonicalIdSchema(
  'TemplateBuildId',
  'Canonical identifier of a single template build run.',
)
export type TemplateBuildId = typeof TemplateBuildIdSchema.Type

export const TemplateAliasSchema = dnsLabelSchema(
  TEMPLATE_ALIAS_MIN_LENGTH,
  TEMPLATE_ALIAS_MAX_LENGTH,
)
  .pipe(Schema.brand('TemplateAlias'))
  .annotations({
    identifier: 'TemplateAlias',
    title: 'Template alias',
    description: `Human-facing DNS-label-compatible template alias, at most ${TEMPLATE_ALIAS_MAX_LENGTH} characters.`,
  })
export type TemplateAlias = typeof TemplateAliasSchema.Type

export const generateTemplateId = (): TemplateId =>
  TemplateIdSchema.make(generateNanoId())

export const generateTemplateBuildId = (): TemplateBuildId =>
  TemplateBuildIdSchema.make(generateNanoId())
