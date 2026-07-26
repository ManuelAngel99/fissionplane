import { generateOrganizationId } from '@fissionplane/core/organizations/types'
import { generateSandboxId } from '@fissionplane/core/sandboxes/types'
import { SandboxSummarySchema } from '@fissionplane/core/sandboxes/views'
import { generateTemplateId } from '@fissionplane/core/templates/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decode = Schema.decodeUnknownEither(SandboxSummarySchema)

const wireSummary = {
  createdAt: '2024-03-01T00:00:00.000Z',
  id: generateSandboxId(),
  organizationId: generateOrganizationId(),
  state: 'running',
  templateId: generateTemplateId(),
}

describe('sandbox summary read model', () => {
  it('decodes the wire shape the console lists', () => {
    expect(Either.isRight(decode(wireSummary))).toBe(true)
  })

  it('rejects identifiers that are not canonical NanoIDs', () => {
    expect(Either.isLeft(decode({ ...wireSummary, id: 'not-a-nano-id' }))).toBe(
      true,
    )
    expect(
      Either.isLeft(decode({ ...wireSummary, templateId: 'sha256:deadbeef' })),
    ).toBe(true)
  })

  it('rejects a non-ISO creation timestamp', () => {
    expect(Either.isLeft(decode({ ...wireSummary, createdAt: 'today' }))).toBe(
      true,
    )
  })
})
