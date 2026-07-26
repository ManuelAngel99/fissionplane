import {
  DomainError,
  InternalError,
  UnauthenticatedError,
  UnauthorizedError,
} from '@fissionplane/core/ddd/base-error'
import { ErrorCode } from '@fissionplane/core/ddd/codes'
import * as HttpApiSchema from '@effect/platform/HttpApiSchema'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

class SampleError extends DomainError<SampleError>()(
  'SampleError',
  'SAMPLE',
  'Sample failed',
  ErrorCode.INTERNAL.statusCode,
  { attempt: Schema.Number },
) {}

describe('DomainError factory', () => {
  it('fills the machine code and default message', () => {
    expect(
      Schema.encodeSync(SampleError)(new SampleError({ attempt: 2 })),
    ).toEqual({
      _tag: 'SampleError',
      attempt: 2,
      code: 'SAMPLE',
      message: 'Sample failed',
    })
  })

  it('lets a call site override the message without losing the code', () => {
    const error = new SampleError({ attempt: 1, message: 'Attempt 1 failed' })

    expect(error.code).toBe('SAMPLE')
    expect(error.message).toBe('Attempt 1 failed')
  })

  it('carries the HTTP status from the error-code catalog', () => {
    expect(HttpApiSchema.getStatusError(SampleError)).toBe(
      ErrorCode.INTERNAL.statusCode,
    )
  })
})

describe('shared domain errors', () => {
  it('maps each shared error to its catalog status', () => {
    expect(HttpApiSchema.getStatusError(UnauthenticatedError)).toBe(401)
    expect(HttpApiSchema.getStatusError(UnauthorizedError)).toBe(403)
    expect(HttpApiSchema.getStatusError(InternalError)).toBe(500)
  })

  it('never leaks internal detail in the default payloads', () => {
    expect(Schema.encodeSync(InternalError)(new InternalError({}))).toEqual({
      _tag: 'InternalError',
      code: 'INTERNAL',
      message: ErrorCode.INTERNAL.message,
    })
  })
})
