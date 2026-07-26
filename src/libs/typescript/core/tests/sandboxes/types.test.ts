import {
  generateSandboxId,
  SANDBOX_NAME_MAX_LENGTH,
  SandboxIdSchema,
  SandboxNameSchema,
  SandboxStateSchema,
} from '@fissionplane/core/sandboxes/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decodeId = Schema.decodeUnknownEither(SandboxIdSchema)
const decodeName = Schema.decodeUnknownEither(SandboxNameSchema)

describe('sandbox value objects', () => {
  it('generates canonical sandbox ids', () => {
    expect(Either.isRight(decodeId(generateSandboxId()))).toBe(true)
    expect(Either.isLeft(decodeId('sandbox-1'))).toBe(true)
  })

  it('validates DNS-safe sandbox names', () => {
    expect(Either.isRight(decodeName('build-runner-1'))).toBe(true)
    expect(Either.isLeft(decodeName('-invalid'))).toBe(true)
    expect(
      Either.isLeft(decodeName('x'.repeat(SANDBOX_NAME_MAX_LENGTH + 1))),
    ).toBe(true)
  })

  it.each([
    'creating',
    'running',
    'pausing',
    'paused',
    'resuming',
    'terminating',
    'terminated',
    'failed',
  ])('accepts the %s lifecycle state', (state) => {
    expect(Schema.is(SandboxStateSchema)(state)).toBe(true)
  })

  it('rejects unknown lifecycle states', () => {
    expect(Schema.is(SandboxStateSchema)('stopped')).toBe(false)
  })
})
