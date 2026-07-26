import {
  HealthSchema,
  ServiceNameSchema,
} from '@fissionplane/core/system/types'
import * as Either from 'effect/Either'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const decode = Schema.decodeUnknownEither(HealthSchema)

describe('service health', () => {
  it.each(ServiceNameSchema.literals)(
    'decodes the %s liveness payload',
    (service) => {
      expect(Either.isRight(decode({ service, status: 'ok' }))).toBe(true)
    },
  )

  it('rejects an unknown service or a degraded status', () => {
    expect(
      Either.isLeft(decode({ service: 'control-plane', status: 'ok' })),
    ).toBe(true)
    expect(
      Either.isLeft(decode({ service: 'console-api', status: 'degraded' })),
    ).toBe(true)
  })
})
