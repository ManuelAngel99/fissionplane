import { OrganizationIdSchema } from '@fissionplane/core/organizations/types'
import {
  SandboxIdSchema,
  SandboxStateSchema,
} from '@fissionplane/core/sandboxes/types'
import { TemplateIdSchema } from '@fissionplane/core/templates/types'
import * as Schema from 'effect/Schema'

/** Read model listed by the console; not the control-plane sandbox aggregate. */
export const SandboxSummarySchema = Schema.Struct({
  id: SandboxIdSchema,
  organizationId: OrganizationIdSchema,
  state: SandboxStateSchema,
  templateId: TemplateIdSchema,
  createdAt: Schema.DateTimeUtc,
}).annotations({
  identifier: 'SandboxSummary',
  title: 'Sandbox summary',
  description: 'Sandbox row rendered in console listings.',
})
export type SandboxSummary = typeof SandboxSummarySchema.Type
