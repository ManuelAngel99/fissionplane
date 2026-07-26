/** The error body every non-2xx response carries. */
export interface ApiErrorBody {
  code: string
  message: string
  retryable?: boolean
  request_id?: string
}

/** Base class for every error raised by the SDK. */
export class FissionPlaneError extends Error {
  /**
   * Creates an SDK error.
   *
   * @param message Human-readable error message.
   * @param status HTTP status, when the error came from a response.
   * @param code Machine-readable error code.
   * @param retryable Whether retrying the request may succeed.
   * @param requestId Platform request identifier.
   */
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable: boolean = false,
    readonly requestId?: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** 401: missing, malformed, or expired credential. */
export class AuthenticationError extends FissionPlaneError {}

/** 403: the credential is valid but does not permit the operation. */
export class ForbiddenError extends FissionPlaneError {}

/** 404: no such resource, for an authenticated caller. */
export class NotFoundError extends FissionPlaneError {}

/**
 * 409: another lifecycle operation holds the mutex, or the sandbox's
 * state does not permit the operation. Re-read the sandbox and decide.
 */
export class ConflictError extends FissionPlaneError {}

/** 410: the snapshot is no longer restorable. */
export class SnapshotExpiredError extends FissionPlaneError {}

/** 429: a quota or rate limit binds; `code` distinguishes which. */
export class RateLimitError extends FissionPlaneError {}

/**
 * 408: the command did not exit within `timeoutSeconds` and has been
 * killed. Data plane only — the control plane never returns 408.
 */
export class CommandTimeoutError extends FissionPlaneError {}

/**
 * A template build ended `failed`. Raised by `TemplateBuild.wait`, not
 * by the response mapper: the failure arrives inside a 200 body.
 */
export class TemplateBuildError extends FissionPlaneError {
  /**
   * Creates an error for a failed template build.
   *
   * @param message Human-readable failure message.
   * @param buildError Error reported by the build service.
   */
  constructor(
    message: string,
    readonly buildError?: string,
  ) {
    super(message)
  }
}

/**
 * Maps a failed response to the matching SDK error class.
 *
 * @param status HTTP response status.
 * @param body API error body, when present.
 * @returns The matching SDK error.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
): FissionPlaneError {
  let message = `request failed with status ${status}`
  let code: string | undefined
  // Rate limits and server faults are retryable unless the body says otherwise.
  let retryable = status === 429 || status >= 500
  let requestId: string | undefined

  if (typeof body === 'object' && body !== null) {
    if ('message' in body && typeof body.message === 'string') {
      message = body.message
    }
    if ('code' in body && typeof body.code === 'string') {
      code = body.code
    }
    if ('retryable' in body && typeof body.retryable === 'boolean') {
      retryable = body.retryable
    }
    if ('request_id' in body && typeof body.request_id === 'string') {
      requestId = body.request_id
    }
  }

  const args = [message, status, code, retryable, requestId] as const

  if (status === 401) return new AuthenticationError(...args)
  if (status === 403) return new ForbiddenError(...args)
  if (status === 404) return new NotFoundError(...args)
  if (status === 408) return new CommandTimeoutError(...args)
  if (status === 409) return new ConflictError(...args)
  if (status === 410) return new SnapshotExpiredError(...args)
  if (status === 429) return new RateLimitError(...args)
  return new FissionPlaneError(...args)
}
