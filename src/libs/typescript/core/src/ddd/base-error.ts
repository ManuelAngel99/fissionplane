// The factory's `T` self-type parameter is referenced only in the returned
// class type, which `no-unnecessary-type-parameters` cannot see.
// oxlint-disable typescript/no-unnecessary-type-parameters

import { ErrorCode } from '@fissionplane/core/ddd/codes'
import * as HttpApiSchema from '@effect/platform/HttpApiSchema'
import * as Schema from 'effect/Schema'

/** Message field that falls back to the error class default when omitted. */
const errorMessage = (message: string) =>
  Schema.optional(Schema.String).pipe(
    Schema.withDefaults({
      constructor: () => message,
      decoding: () => message,
    }),
  )

/**
 * Build a tagged error class with a fixed machine `code`, a default `message`,
 * and an HTTP status annotation.
 *
 * Both `code` and `message` are schema fields, so every error serializes to a
 * stable JSON payload over HTTP. Extra `fields` are part of the wire contract
 * too; keep server-only context out of them.
 */
export const DomainError =
  <T>() =>
  <
    Tag extends string,
    Code extends string,
    Fields extends Schema.Struct.Fields,
  >(
    tag: Tag,
    code: Code,
    message: string,
    statusCode: number,
    fields: Fields,
  ) =>
    Schema.TaggedError<T>()(
      tag,
      {
        ...fields,
        code: Schema.tag(code),
        message: errorMessage(message),
      },
      HttpApiSchema.annotations({ status: statusCode }),
    )

/** No Better Auth session backs the request. Maps to HTTP 401. */
export class UnauthenticatedError extends DomainError<UnauthenticatedError>()(
  'UnauthenticatedError',
  'UNAUTHENTICATED',
  ErrorCode.UNAUTHENTICATED.message,
  ErrorCode.UNAUTHENTICATED.statusCode,
  {},
) {}

/**
 * The caller is authenticated but not allowed on this surface.
 *
 * Use it for trust domains that have no organization role, such as the
 * backoffice operator gate, or for a tenant session whose active organization
 * membership cannot be resolved. Denials of a specific grant use
 * `ForbiddenError` from `@fissionplane/core/organizations/errors`. Maps to
 * HTTP 403.
 */
export class UnauthorizedError extends DomainError<UnauthorizedError>()(
  'UnauthorizedError',
  'UNAUTHORIZED',
  ErrorCode.UNAUTHORIZED.message,
  ErrorCode.UNAUTHORIZED.statusCode,
  {},
) {}

/** Unexpected server failure. Maps to HTTP 500. */
export class InternalError extends DomainError<InternalError>()(
  'InternalError',
  'INTERNAL',
  ErrorCode.INTERNAL.message,
  ErrorCode.INTERNAL.statusCode,
  {},
) {}
