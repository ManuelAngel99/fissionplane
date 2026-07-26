import { HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

export interface DomainErrorPayload {
  readonly body: string
  readonly status: number
}

/**
 * Encode a domain error to the same JSON body and status the Effect HTTP
 * contract would produce, so gates that run before Effect stay consistent.
 */
export const domainErrorPayload = <A, I>(
  schema: Schema.Schema<A, I>,
  error: A,
): DomainErrorPayload => ({
  body: JSON.stringify(Schema.encodeSync(schema)(error)),
  status: HttpApiSchema.getStatusError(schema),
})

export const domainErrorResponse = <A, I>(
  schema: Schema.Schema<A, I>,
  error: A,
): Response => {
  const { body, status } = domainErrorPayload(schema, error)
  return new Response(body, {
    headers: { 'content-type': 'application/json' },
    status,
  })
}
