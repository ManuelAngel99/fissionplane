import {
  canonicalIdSchema,
  generateNanoId,
} from '@fissionplane/core/shared/identifiers'
import { dnsLabelSchema } from '@fissionplane/core/shared/names'
import * as Schema from 'effect/Schema'

export const SANDBOX_NAME_MIN_LENGTH = 1
export const SANDBOX_NAME_MAX_LENGTH = 63

export const SandboxIdSchema = canonicalIdSchema(
  'SandboxId',
  'Canonical identifier of a sandbox in the Rust control-plane catalog.',
)
export type SandboxId = typeof SandboxIdSchema.Type

export const SandboxNameSchema = dnsLabelSchema(
  SANDBOX_NAME_MIN_LENGTH,
  SANDBOX_NAME_MAX_LENGTH,
)
  .pipe(Schema.brand('SandboxName'))
  .annotations({
    identifier: 'SandboxName',
    title: 'Sandbox name',
    description: `DNS-label-compatible sandbox name, at most ${SANDBOX_NAME_MAX_LENGTH} characters.`,
  })
export type SandboxName = typeof SandboxNameSchema.Type

export const SandboxStateSchema = Schema.Literal(
  'creating',
  'running',
  'pausing',
  'paused',
  'resuming',
  'terminating',
  'terminated',
  'failed',
).annotations({
  identifier: 'SandboxState',
  title: 'Sandbox state',
  description: 'Lifecycle state reported by the Rust control plane.',
})
export type SandboxState = typeof SandboxStateSchema.Type

export const generateSandboxId = (): SandboxId =>
  SandboxIdSchema.make(generateNanoId())
