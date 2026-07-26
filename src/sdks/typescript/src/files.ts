import createClient, { type Client } from 'openapi-fetch'

import type { paths as dataplanePaths } from './dataplane/schema.gen'
import type { components as dataplane } from './dataplane/schema.gen'
import {
  capabilityToken,
  dataPlaneOrigin,
  DEFAULT_AGENT_PORT,
  openDataPlaneWebSocket,
  withFreshToken,
  type DataPlaneOptions,
  type TokenSource,
  type WebSocketFactory,
} from './dataplane'
import { errorFromResponse } from './errors'
import { unwrap } from './api'
import { defaultHeaders } from './api/metadata'
import {
  createHttpFetch,
  RequestPipeline,
  type CallInit,
  type CallSpec,
  type RequestOptions,
} from './http'
import {
  isPositiveInteger,
  parseJsonObject,
  StreamingEvents,
  StreamingProtocolError,
  type StreamOptions,
} from './streaming'

/** Metadata for a file, directory, symlink, or other filesystem entry. */
export type FileInfo = dataplane['schemas']['FileInfo']

/** Filesystem entry kind. */
export type FileKind = dataplane['schemas']['FileKind']

/** Options for creating a directory. */
export interface MakeDirectoryOptions extends RequestOptions {
  /** Create missing parent directories. Defaults to true. */
  parents?: boolean
  /** Unix permission bits in octal, for example `0755`. */
  mode?: string
}

/** Options for moving a path. */
export interface MoveFileOptions extends RequestOptions {
  /** Replace an existing destination. Defaults to false. */
  overwrite?: boolean
}

/** Options for removing a path. */
export interface RemoveFileOptions extends RequestOptions {
  /** Recursively remove a directory. Defaults to false. */
  recursive?: boolean
}

/** Options for writing file bytes. */
export interface WriteFileOptions extends RequestOptions {
  /** Unix permission bits in octal, for example `0644`. */
  mode?: string
}

/**
 * Options for watching filesystem changes.
 *
 * `requestTimeoutMs` bounds the WebSocket handshake, not the lifetime
 * of the watch; `signal` closes the watch.
 */
export interface WatchFilesOptions extends RequestOptions {
  /** Include changes below child directories. Defaults to false. */
  recursive?: boolean
  /** Last event sequence already observed. Defaults to zero. */
  after?: number
}

/** A validated filesystem watch event. */
export type FileWatchEvent =
  | {
      type: 'created' | 'modified' | 'removed'
      sequence: number
      path: string
      kind: FileKind
    }
  | {
      type: 'moved'
      sequence: number
      path: string
      oldPath: string
      kind: FileKind
    }
  | { type: 'overflow'; sequence: number }

function isFileKind(value: unknown): value is FileKind {
  return (
    value === 'file' ||
    value === 'directory' ||
    value === 'symlink' ||
    value === 'other'
  )
}

function parseFileWatchEvent(data: unknown): FileWatchEvent | undefined {
  const message = parseJsonObject(data)
  if (typeof message['type'] !== 'string') {
    throw new StreamingProtocolError('file watch frame type must be a string')
  }
  switch (message['type']) {
    case 'created':
    case 'modified':
    case 'removed':
      if (
        !isPositiveInteger(message['sequence']) ||
        typeof message['path'] !== 'string' ||
        !isFileKind(message['kind'])
      ) {
        throw new StreamingProtocolError(
          `malformed known ${message['type']} frame`,
        )
      }
      return {
        type: message['type'],
        sequence: message['sequence'],
        path: message['path'],
        kind: message['kind'],
      }
    case 'moved':
      if (
        !isPositiveInteger(message['sequence']) ||
        typeof message['path'] !== 'string' ||
        typeof message['old_path'] !== 'string' ||
        !isFileKind(message['kind'])
      ) {
        throw new StreamingProtocolError('malformed known moved frame')
      }
      return {
        type: 'moved',
        sequence: message['sequence'],
        path: message['path'],
        oldPath: message['old_path'],
        kind: message['kind'],
      }
    case 'overflow':
      if (!isPositiveInteger(message['sequence'])) {
        throw new StreamingProtocolError('malformed known overflow frame')
      }
      return { type: 'overflow', sequence: message['sequence'] }
    default:
      return undefined
  }
}

/** A filesystem watch WebSocket with typed events and async iteration. */
export class FileWatch extends StreamingEvents<FileWatchEvent> {
  protected parse(data: unknown): FileWatchEvent | undefined {
    return parseFileWatchEvent(data)
  }
}

/** Filesystem operations inside a sandbox, available as `sandbox.files`. */
export class SandboxFiles {
  private client?: Client<dataplanePaths>
  private clientToken?: string
  private readonly agentPort: number
  private readonly fetch: typeof globalThis.fetch
  private readonly webSocket?: WebSocketFactory
  private readonly requests: RequestPipeline

  /**
   * Creates a filesystem module bound to a sandbox handle.
   *
   * @param sandbox Source of the current sandbox identity and token.
   * @param options Data-plane connection settings and request defaults.
   */
  constructor(
    private readonly sandbox: TokenSource,
    options?: DataPlaneOptions,
  ) {
    this.agentPort = options?.agentPort ?? DEFAULT_AGENT_PORT
    this.requests = new RequestPipeline(options)
    this.fetch = createHttpFetch(this.requests.requestTimeoutMs, options?.fetch)
    this.webSocket = options?.webSocket
  }

  /**
   * Lists entries directly below a directory.
   *
   * @param path Directory to read.
   * @param options Per-call timeout, signal, and headers.
   */
  async list(path: string, options?: RequestOptions): Promise<FileInfo[]> {
    const page = await this.call(
      { operation: 'GET /files', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.GET('/files', { params: { query: { path } }, ...init }),
        ),
    )
    return page.items
  }

  /**
   * Reads metadata for a path.
   *
   * @param path Path to describe.
   * @param options Per-call timeout, signal, and headers.
   */
  async stat(path: string, options?: RequestOptions): Promise<FileInfo> {
    return this.call(
      { operation: 'GET /files/stat', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.GET('/files/stat', {
            params: { query: { path } },
            ...init,
          }),
        ),
    )
  }

  /** Creates a directory. */
  async makeDir(path: string, options?: MakeDirectoryOptions): Promise<void> {
    await this.call(
      { operation: 'POST /files/directories', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.POST('/files/directories', {
            body: {
              path,
              parents: options?.parents ?? true,
              ...(options?.mode !== undefined && { mode: options.mode }),
            },
            ...init,
          }),
        ),
    )
  }

  /** Moves or renames a path. */
  async move(
    source: string,
    destination: string,
    options?: MoveFileOptions,
  ): Promise<void> {
    await this.call(
      { operation: 'POST /files/move', idempotent: false, options },
      async (client, init) =>
        unwrap(
          await client.POST('/files/move', {
            body: {
              source,
              destination,
              overwrite: options?.overwrite ?? false,
            },
            ...init,
          }),
        ),
    )
  }

  /** Removes a file or directory. */
  async remove(path: string, options?: RemoveFileOptions): Promise<void> {
    await this.call(
      { operation: 'DELETE /files', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.DELETE('/files', {
            params: {
              query: {
                path,
                ...(options?.recursive !== undefined && {
                  recursive: options.recursive,
                }),
              },
            },
            ...init,
          }),
        ),
    )
  }

  /**
   * Downloads a file as bytes.
   *
   * @param path File to read.
   * @param options Per-call timeout, signal, and headers.
   */
  async read(path: string, options?: RequestOptions): Promise<Uint8Array> {
    const response = await this.request(
      '/files/content',
      { operation: 'GET /files/content', idempotent: true, options },
      { method: 'GET', query: { path } },
    )
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Alias for {@link SandboxFiles.read}. */
  download(path: string, options?: RequestOptions): Promise<Uint8Array> {
    return this.read(path, options)
  }

  /** Atomically writes bytes to a file. */
  async write(
    path: string,
    bytes: Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void> {
    await this.request(
      '/files/content',
      { operation: 'PUT /files/content', idempotent: true, options },
      {
        method: 'PUT',
        query: { path, mode: options?.mode },
        body: Uint8Array.from(bytes),
      },
    )
  }

  /** Alias for {@link SandboxFiles.write}. */
  upload(
    path: string,
    bytes: Uint8Array,
    options?: WriteFileOptions,
  ): Promise<void> {
    return this.write(path, bytes, options)
  }

  /**
   * Watches a path for filesystem changes over WebSocket.
   *
   * The handle must already hold a capability token: a handshake the
   * agent rejects reaches the SDK as an opaque socket failure, so the
   * automatic re-mint that covers the HTTP calls here cannot apply.
   *
   * @param path Path to watch.
   * @param options Recursion, sequence to resume from, handshake timeout, and signal.
   */
  watch(path: string, options?: WatchFilesOptions): FileWatch {
    const after = options?.after ?? 0
    if (!Number.isInteger(after) || after < 0) {
      throw new RangeError('after must be a non-negative integer')
    }
    const socket = openDataPlaneWebSocket(
      this.sandbox,
      this.agentPort,
      this.webSocket,
      '/files/watch',
      {
        path,
        recursive: options?.recursive ?? false,
        after,
      },
    )
    return new FileWatch(socket, this.streamOptions(options))
  }

  private dataplane(): Client<dataplanePaths> {
    const token = capabilityToken(this.sandbox)
    if (this.client === undefined || this.clientToken !== token) {
      this.client = createClient<dataplanePaths>({
        baseUrl: dataPlaneOrigin(this.sandbox, this.agentPort),
        headers: { ...defaultHeaders, 'X-Sandbox-Token': token },
        fetch: this.fetch,
      })
      this.clientToken = token
    }
    return this.client
  }

  /**
   * Runs one data-plane call with retry and automatic recovery from a
   * rejected capability token.
   */
  private call<T>(
    spec: CallSpec,
    run: (client: Client<dataplanePaths>, init: CallInit) => Promise<T>,
  ): Promise<T> {
    return withFreshToken(this.sandbox, this.requests.logger, () => {
      // Resolved outside the retry loop: an unarmed handle is a caller
      // mistake, not a failure worth replaying.
      const client = this.dataplane()
      return this.requests.send(spec, (init) => run(client, init))
    })
  }

  /** Maps per-call overrides onto a stream's connection settings. */
  private streamOptions(options?: RequestOptions): StreamOptions {
    return {
      handshakeTimeoutMs:
        options?.requestTimeoutMs ?? this.requests.requestTimeoutMs,
      ...(options?.signal !== undefined && { signal: options.signal }),
    }
  }

  /**
   * Sends a raw byte-stream request; the octet-stream endpoints carry
   * no JSON envelope, so they bypass the generated client.
   */
  private request(
    path: string,
    spec: CallSpec,
    request: {
      method: 'GET' | 'PUT'
      query: Record<string, string | undefined>
      body?: BodyInit
    },
  ): Promise<Response> {
    const url = new URL(path, dataPlaneOrigin(this.sandbox, this.agentPort))
    for (const [name, value] of Object.entries(request.query)) {
      if (value !== undefined) url.searchParams.set(name, value)
    }
    return withFreshToken(this.sandbox, this.requests.logger, () => {
      // Resolved outside the retry loop: an unarmed handle is a caller
      // mistake, not a failure worth replaying.
      const token = capabilityToken(this.sandbox)
      return this.requests.send(spec, async (init) => {
        const response = await this.fetch(url, {
          method: request.method,
          headers: {
            'X-Sandbox-Token': token,
            ...(request.body !== undefined && {
              'Content-Type': 'application/octet-stream',
            }),
            ...init.headers,
          },
          body: request.body,
          ...(init.signal !== undefined && { signal: init.signal }),
        })
        if (!response.ok) {
          let body: unknown
          try {
            body = await response.json()
          } catch {
            body = undefined
          }
          throw errorFromResponse(response.status, body)
        }
        return response
      })
    })
  }
}
