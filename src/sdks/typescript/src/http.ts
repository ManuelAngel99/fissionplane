import { defaultHeaders } from './api/metadata'
import { FissionPlaneError } from './errors'

/**
 * Sink for the SDK's diagnostic messages. Every method is optional, so
 * `console` satisfies the type as-is.
 *
 * @example
 * ```ts
 * const client = new FissionPlane({ logger: console })
 * ```
 */
export interface Logger {
  /** Records request retries, token re-mints, and page fetches. */
  debug?(message: string): void
  /** Records notable but expected events. */
  info?(message: string): void
  /** Records recoverable problems. */
  warn?(message: string): void
  /** Records failures the SDK could not recover from. */
  error?(message: string): void
}

/** Per-call overrides accepted by the ergonomic layer's method options. */
export interface RequestOptions {
  /**
   * Abort this call after this many milliseconds. `0` disables the
   * timeout for the call.
   *
   * @default the client's `requestTimeoutMs`
   */
  requestTimeoutMs?: number
  /** Signal that aborts this call; combined with the timeout. */
  signal?: AbortSignal
  /** Extra headers for this call; they override the SDK's own. */
  headers?: Record<string, string>
}

/** Client-wide request behaviour, shared by both planes. */
export interface RequestDefaults {
  /**
   * Abort every request after this many milliseconds. `0` disables
   * timeouts.
   *
   * @default 60000
   */
  requestTimeoutMs?: number
  /**
   * Extra attempts after a retryable failure. `0` disables retries.
   *
   * @default 2
   */
  maxRetries?: number
  /**
   * Diagnostic sink for retries, token re-mints, and page fetches.
   *
   * @default a no-op logger
   */
  logger?: Logger
}

/** Requests abort after one minute unless the caller says otherwise. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

/** A failed request is attempted at most twice more by default. */
export const DEFAULT_MAX_RETRIES = 2

const RETRY_BASE_DELAY_MS = 250
const RETRY_DELAY_FACTOR = 2
const RETRY_MAX_DELAY_MS = 8_000

/**
 * Carries a per-call timeout from the ergonomic layer to the fetch
 * wrapper. It never leaves the process: the wrapper strips it.
 */
const TIMEOUT_HEADER = 'x-fissionplane-request-timeout-ms'

/** The `openapi-fetch` init fragment produced from per-call overrides. */
export interface CallInit {
  signal?: AbortSignal
  headers?: Record<string, string>
}

/** Identifies one logical call to the retry loop and the logger. */
export interface CallSpec {
  /** Operation name used in log messages, for example `GET /v1/sandboxes`. */
  operation: string
  /** Whether replaying the call is safe when its outcome is unknown. */
  idempotent: boolean
  /** The caller's per-call overrides. */
  options?: RequestOptions
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wraps a fetch implementation so every request carries the SDK's
 * default headers and aborts once its timeout elapses.
 *
 * The wrapper honours a signal the caller already set: the request
 * aborts when either that signal or the timeout fires. The deadline
 * uses an explicit controller and timer rather than
 * `AbortSignal.timeout`, whose timer a runtime may collect while the
 * request is still in flight.
 *
 * @param requestTimeoutMs Default timeout in milliseconds; `0` disables it.
 * @param fetchImpl Underlying fetch implementation.
 * @returns A fetch implementation with headers and timeouts applied.
 */
export function createHttpFetch(
  requestTimeoutMs: number,
  fetchImpl?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const send = fetchImpl ?? globalThis.fetch
  return async (input, init) => {
    const request = new Request(input, init)
    const headers = new Headers(request.headers)
    const override = headers.get(TIMEOUT_HEADER)
    headers.delete(TIMEOUT_HEADER)
    for (const [name, value] of Object.entries(defaultHeaders)) {
      if (!headers.has(name)) headers.set(name, value)
    }

    const timeoutMs = override !== null ? Number(override) : requestTimeoutMs
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return send(new Request(request, { headers }))
    }

    const deadline = new AbortController()
    const abort = () => deadline.abort(request.signal.reason)
    if (request.signal.aborted) abort()
    else request.signal.addEventListener('abort', abort, { once: true })

    // `outbound` stays referenced past the await on purpose: a Request
    // holds the only strong reference to the controller forwarding
    // `deadline` to it, so dropping it lets a collection cycle sever
    // the abort chain mid-flight.
    const outbound = new Request(request, { headers, signal: deadline.signal })

    // The deadline decides the outcome and the abort merely releases
    // the transport, so a fetch implementation that ignores its signal
    // still cannot outlive the timeout.
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new FissionPlaneError(
            `request to ${outbound.url} timed out after ${timeoutMs}ms`,
            undefined,
            'request_timeout',
            true,
          ),
        )
        deadline.abort()
      }, timeoutMs)
    })

    try {
      return await Promise.race([send(outbound), expiry])
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener('abort', abort)
    }
  }
}

/**
 * Whether a failure justifies another attempt.
 *
 * A call whose outcome the caller cannot deduplicate is never replayed:
 * a request that failed in transit may still have been applied. The
 * rest follow the platform's own `retryable` verdict, which covers
 * timeouts, rate limits, and server faults.
 */
function shouldRetry(error: unknown, idempotent: boolean): boolean {
  if (!idempotent) return false
  if (error instanceof FissionPlaneError) return error.retryable
  // `fetch` reports network failures as a plain TypeError.
  return error instanceof TypeError
}

/** Full jitter over an exponentially growing, capped window. */
function retryDelayMs(attempt: number): number {
  const window = Math.min(
    RETRY_BASE_DELAY_MS * RETRY_DELAY_FACTOR ** attempt,
    RETRY_MAX_DELAY_MS,
  )
  return Math.random() * window
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Applies the client's request defaults to every ergonomic-layer call:
 * per-call overrides, bounded retry with jittered backoff, and logging.
 *
 * The typed client exposed as `client.api` keeps the timeout and the
 * default headers but not the retry loop, which lives here.
 */
export class RequestPipeline {
  /** Default request timeout in milliseconds; `0` disables timeouts. */
  readonly requestTimeoutMs: number
  /** Extra attempts after a retryable failure. */
  readonly maxRetries: number
  /** Diagnostic sink; every method is optional. */
  readonly logger: Logger

  /**
   * Creates a pipeline from the client's request defaults.
   *
   * @param defaults Timeout, retry budget, and logger.
   */
  constructor(defaults?: RequestDefaults) {
    this.requestTimeoutMs =
      defaults?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.maxRetries = defaults?.maxRetries ?? DEFAULT_MAX_RETRIES
    this.logger = defaults?.logger ?? {}
  }

  /**
   * Translates per-call overrides into an `openapi-fetch` init fragment.
   *
   * @param options The caller's per-call overrides.
   * @returns Headers and signal to spread into the request.
   */
  init(options?: RequestOptions): CallInit {
    const headers: Record<string, string> = { ...options?.headers }
    if (options?.requestTimeoutMs !== undefined) {
      headers[TIMEOUT_HEADER] = String(options.requestTimeoutMs)
    }
    return {
      ...(options?.signal !== undefined && { signal: options.signal }),
      ...(Object.keys(headers).length > 0 && { headers }),
    }
  }

  /**
   * Runs one call, replaying it while the failure looks retryable and
   * the retry budget allows.
   *
   * @param spec Operation name, idempotency, and per-call overrides.
   * @param run Performs one attempt with the resolved init fragment.
   * @returns The first successful attempt's result.
   * @throws {FissionPlaneError} The last attempt's failure.
   */
  async send<T>(
    spec: CallSpec,
    run: (init: CallInit) => Promise<T>,
  ): Promise<T> {
    const init = this.init(spec.options)
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await run(init)
      } catch (error) {
        if (
          attempt >= this.maxRetries ||
          !shouldRetry(error, spec.idempotent)
        ) {
          throw error
        }
        const delayMs = retryDelayMs(attempt)
        this.logger.debug?.(
          `${spec.operation} failed (${describe(error)}); ` +
            `retrying in ${Math.round(delayMs)}ms ` +
            `(attempt ${attempt + 2} of ${this.maxRetries + 1})`,
        )
        await sleep(delayMs, spec.options?.signal)
      }
    }
  }
}
