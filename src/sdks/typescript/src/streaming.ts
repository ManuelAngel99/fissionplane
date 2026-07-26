import type { WebSocketConnection } from './dataplane'
import { FissionPlaneError } from './errors'

type Listener<T> = (event: T) => void

interface PendingEvent<T> {
  resolve(result: IteratorResult<T>): void
  reject(error: unknown): void
}

/** Deadline and cancellation applied to a stream's connection. */
export interface StreamOptions {
  /** Fail the stream when the handshake takes longer than this. */
  handshakeTimeoutMs?: number
  /** Signal that closes the stream. */
  signal?: AbortSignal
}

export class StreamingProtocolError extends Error {}

export abstract class StreamingEvents<T> implements AsyncIterable<T> {
  private readonly listeners = new Set<Listener<T>>()
  private readonly queue: T[] = []
  private readonly pending: PendingEvent<T>[] = []
  private readonly outbound: string[] = []
  private handshake?: ReturnType<typeof setTimeout>
  private opened = false
  private ended = false
  private failure?: unknown

  constructor(
    protected readonly socket: WebSocketConnection,
    options?: StreamOptions,
  ) {
    socket.onOpen = () => {
      this.clearHandshake()
      if (socket.protocol !== 'fissionplane.v1') {
        this.fail(
          new StreamingProtocolError('server did not select fissionplane.v1'),
        )
        return
      }
      this.opened = true
      for (const frame of this.outbound.splice(0)) socket.send(frame)
    }
    socket.onMessage = (data) => {
      try {
        this.receive(data)
      } catch (error) {
        this.fail(error)
      }
    }
    socket.onClose = () => this.finish()
    socket.onError = (error) => this.fail(error)

    const handshakeTimeoutMs = options?.handshakeTimeoutMs ?? 0
    if (handshakeTimeoutMs > 0) {
      this.handshake = setTimeout(() => {
        this.fail(
          new FissionPlaneError(
            `WebSocket handshake did not complete within ${handshakeTimeoutMs}ms`,
            undefined,
            'handshake_timeout',
            true,
          ),
        )
      }, handshakeTimeoutMs)
      // Never hold a Node process open waiting on a handshake.
      ;(this.handshake as { unref?: () => void }).unref?.()
    }
    options?.signal?.addEventListener('abort', () => this.close(), {
      once: true,
    })
  }

  /** Registers a listener for every validated stream event. */
  onEvent(listener: Listener<T>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Returns an async iterator over validated stream events. */
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const event = this.queue.shift()
        if (event !== undefined) {
          return Promise.resolve({ value: event, done: false })
        }
        if (this.failure !== undefined) return Promise.reject(this.failure)
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve, reject) =>
          this.pending.push({ resolve, reject }),
        )
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }

  /** Closes the WebSocket and ends async iteration. */
  close(): void {
    if (this.ended) return
    this.finish()
    this.socket.close()
  }

  protected send(frame: object): void {
    if (this.ended) return
    const encoded = JSON.stringify(frame)
    if (this.opened) this.socket.send(encoded)
    else this.outbound.push(encoded)
  }

  protected abstract parse(data: unknown): T | undefined

  private receive(data: unknown): void {
    const event = this.parse(data)
    if (event === undefined || this.ended) return
    for (const listener of this.listeners) listener(event)
    const pending = this.pending.shift()
    if (pending !== undefined) pending.resolve({ value: event, done: false })
    else this.queue.push(event)
  }

  private clearHandshake(): void {
    if (this.handshake === undefined) return
    clearTimeout(this.handshake)
    this.handshake = undefined
  }

  private finish(): void {
    if (this.ended) return
    this.clearHandshake()
    this.ended = true
    this.outbound.length = 0
    for (const pending of this.pending.splice(0)) {
      pending.resolve({ value: undefined, done: true })
    }
  }

  private fail(error: unknown): void {
    if (this.ended) return
    this.clearHandshake()
    this.failure = error
    this.ended = true
    this.outbound.length = 0
    for (const pending of this.pending.splice(0)) pending.reject(error)
    this.socket.close()
  }
}

export function parseJsonObject(data: unknown): Record<string, unknown> {
  if (typeof data !== 'string') {
    throw new StreamingProtocolError('expected a JSON text frame')
  }
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch {
    throw new StreamingProtocolError('received malformed JSON text frame')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StreamingProtocolError('expected a JSON object frame')
  }
  return Object.fromEntries(Object.entries(value))
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}
