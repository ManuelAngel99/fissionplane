import createClient, { type Client } from 'openapi-fetch'

import { unwrap } from './api'
import type {
  components as dataplane,
  paths as dataplanePaths,
} from './dataplane/schema.gen'
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
import { defaultHeaders } from './api/metadata'
import {
  createHttpFetch,
  RequestPipeline,
  type CallInit,
  type CallSpec,
  type RequestOptions,
} from './http'
import {
  isNonNegativeInteger,
  isPositiveInteger,
  parseJsonObject,
  StreamingEvents,
  StreamingProtocolError,
  type StreamOptions,
} from './streaming'

/** A finished command: exit code and captured output. */
export type CommandResult = dataplane['schemas']['CommandResult']

/** One process the agent supervises inside the sandbox. */
export type Process = dataplane['schemas']['Process']

/** A snapshot of retained output for a background process. */
export type ProcessLogs = dataplane['schemas']['ProcessLogs']

/** Terminal dimensions used when starting or resizing a PTY process. */
export type PtySize = dataplane['schemas']['PtySize']

/** Signals {@link Commands.kill} can deliver. */
export type Signal = 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP'

/** Options for running a command. */
export interface RunCommandOptions extends RequestOptions {
  /** Arguments passed to the program. */
  args?: string[]
  /**
   * Working directory for the command.
   *
   * @default the default user's home directory
   */
  cwd?: string
  /** Environment variables set for this command only. */
  env?: Record<string, string>
  /** Bytes written to the command's stdin before it is closed. */
  stdin?: string
  /**
   * Kill the command if it has not exited after this many seconds.
   *
   * @default the agent's default
   */
  timeoutSeconds?: number
}

/** Options for starting a supervised background process. */
export interface StartProcessOptions extends RequestOptions {
  /** Arguments passed to the program. */
  args?: string[]
  /** Working directory for the process. */
  cwd?: string
  /** Environment variables set for this process only. */
  env?: Record<string, string>
  /** Allocate a PTY with these initial dimensions. */
  pty?: PtySize
}

/**
 * Options for attaching to retained and live process output.
 *
 * `requestTimeoutMs` bounds the WebSocket handshake, not the lifetime
 * of the stream; `signal` closes the stream.
 */
export interface AttachProcessOptions extends RequestOptions {
  /** Last output sequence already observed. */
  after?: number
}

/** A validated event received from an attached process stream. */
export type ProcessStreamEvent =
  | { type: 'stdout'; sequence: number; data: string }
  | { type: 'stderr'; sequence: number; data: string }
  | { type: 'exit'; sequence: number; exitCode: number }
  | { type: 'gap'; fromSequence: number; toSequence: number }

function parseProcessStreamEvent(
  data: unknown,
): ProcessStreamEvent | undefined {
  const message = parseJsonObject(data)
  if (typeof message['type'] !== 'string') {
    throw new StreamingProtocolError(
      'process stream frame type must be a string',
    )
  }
  switch (message['type']) {
    case 'stdout':
    case 'stderr':
      if (
        !isPositiveInteger(message['sequence']) ||
        typeof message['data'] !== 'string'
      ) {
        throw new StreamingProtocolError(
          `malformed known ${message['type']} frame`,
        )
      }
      return {
        type: message['type'],
        sequence: message['sequence'],
        data: message['data'],
      }
    case 'exit':
      if (
        !isPositiveInteger(message['sequence']) ||
        typeof message['exit_code'] !== 'number' ||
        !Number.isInteger(message['exit_code'])
      ) {
        throw new StreamingProtocolError('malformed known exit frame')
      }
      return {
        type: 'exit',
        sequence: message['sequence'],
        exitCode: message['exit_code'],
      }
    case 'gap':
      if (
        !isPositiveInteger(message['from_sequence']) ||
        !isPositiveInteger(message['to_sequence'])
      ) {
        throw new StreamingProtocolError('malformed known gap frame')
      }
      return {
        type: 'gap',
        fromSequence: message['from_sequence'],
        toSequence: message['to_sequence'],
      }
    default:
      return undefined
  }
}

/** A live process WebSocket with typed events and interactive controls. */
export class ProcessAttachment extends StreamingEvents<ProcessStreamEvent> {
  protected parse(data: unknown): ProcessStreamEvent | undefined {
    return parseProcessStreamEvent(data)
  }

  /** Writes text to the process stdin. */
  sendInput(data: string): void {
    this.send({ type: 'input', data })
  }

  /** Closes the process stdin without closing the output stream. */
  closeStdin(): void {
    this.send({ type: 'close_stdin' })
  }

  /** Changes the dimensions of an attached PTY. */
  resize(cols: number, rows: number): void {
    this.send({ type: 'resize', cols, rows })
  }

  /** Delivers a signal to the process through the attached stream. */
  signal(signal: Signal): void {
    this.send({ type: 'signal', signal })
  }
}

/** Ergonomic operations bound to one supervised process. */
export class ProcessHandle {
  constructor(
    private readonly commands: Commands,
    public info: Process,
  ) {}

  /** The process identifier. */
  get pid(): number {
    return this.info.pid
  }

  /** Refreshes and returns process metadata. */
  async refresh(options?: RequestOptions): Promise<Process> {
    this.info = await this.commands.getProcess(this.pid, options)
    return this.info
  }

  /** Reads the retained output snapshot. */
  logs(after?: number, options?: RequestOptions): Promise<ProcessLogs> {
    return this.commands.logs(this.pid, after, options)
  }

  /** Attaches to retained and live output. */
  attach(options?: AttachProcessOptions): ProcessAttachment {
    return this.commands.attach(this.pid, options)
  }

  /** Sends a signal to this process. */
  kill(signal?: Signal, options?: RequestOptions): Promise<void> {
    return this.commands.kill(this.pid, signal, options)
  }
}

/**
 * Module for running commands inside the sandbox, available as
 * `sandbox.commands`.
 *
 * @example
 * ```ts
 * const sandbox = await client.sandboxes.create({ template: 'base' })
 * const result = await sandbox.commands.run('echo', { args: ['hello'] })
 * console.log(result.stdout) // hello
 * ```
 */
export class Commands {
  private client?: Client<dataplanePaths>
  private clientToken?: string
  private readonly agentPort: number
  private readonly fetch: typeof globalThis.fetch
  private readonly webSocket?: WebSocketFactory
  private readonly requests: RequestPipeline

  /**
   * Creates a command module bound to a sandbox handle.
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

  /** Returns a client for the current token, rebuilding it after token rotation. */
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

  /**
   * Run a command to completion and return its captured output.
   *
   * Blocks until the command exits or `timeoutSeconds` elapses. The
   * response marks output that exceeded the capture limit as truncated.
   *
   * @param command The program to run.
   * @param opts Options for running the command.
   * @returns The command result.
   * @throws {CommandTimeoutError} When the command exceeds `timeoutSeconds`.
   *
   * @example
   * ```ts
   * const result = await sandbox.commands.run('python3', {
   *   args: ['-c', 'print(6 * 7)'],
   *   timeoutSeconds: 60,
   * })
   * console.log(result.stdout) // 42
   * ```
   */
  async run(command: string, opts?: RunCommandOptions): Promise<CommandResult> {
    return this.call(
      { operation: 'POST /commands', idempotent: false, options: opts },
      async (client, init) =>
        unwrap(
          await client.POST('/commands', {
            body: {
              command,
              ...(opts?.args !== undefined && { args: opts.args }),
              ...(opts?.cwd !== undefined && { cwd: opts.cwd }),
              ...(opts?.env !== undefined && { env: opts.env }),
              ...(opts?.stdin !== undefined && { stdin: opts.stdin }),
              ...(opts?.timeoutSeconds !== undefined && {
                timeout_seconds: opts.timeoutSeconds,
              }),
            },
            ...init,
          }),
        ),
    )
  }

  /**
   * Starts a supervised process and returns a handle immediately.
   *
   * Pass `pty` to allocate a terminal; then call `attach()` on the
   * returned handle to interact with it.
   */
  async start(
    command: string,
    opts?: StartProcessOptions,
  ): Promise<ProcessHandle> {
    const process = await this.call(
      { operation: 'POST /processes', idempotent: false, options: opts },
      async (client, init) =>
        unwrap(
          await client.POST('/processes', {
            body: {
              command,
              ...(opts?.args !== undefined && { args: opts.args }),
              ...(opts?.cwd !== undefined && { cwd: opts.cwd }),
              ...(opts?.env !== undefined && { env: opts.env }),
              ...(opts?.pty !== undefined && { pty: opts.pty }),
            },
            ...init,
          }),
        ),
    )
    return new ProcessHandle(this, process)
  }

  /**
   * Gets one supervised process.
   *
   * @param pid Process ID from {@link Commands.listProcesses}.
   * @param options Per-call timeout, signal, and headers.
   */
  async get(pid: number, options?: RequestOptions): Promise<ProcessHandle> {
    return new ProcessHandle(this, await this.getProcess(pid, options))
  }

  /**
   * Gets raw metadata for one supervised process.
   *
   * @param pid Process ID from {@link Commands.listProcesses}.
   * @param options Per-call timeout, signal, and headers.
   */
  async getProcess(pid: number, options?: RequestOptions): Promise<Process> {
    return this.call(
      { operation: 'GET /processes/{pid}', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.GET('/processes/{pid}', {
            params: { path: { pid } },
            ...init,
          }),
        ),
    )
  }

  /**
   * Reads retained output for a supervised process.
   *
   * @param pid Process ID from {@link Commands.listProcesses}.
   * @param after Last output sequence already observed.
   * @param options Per-call timeout, signal, and headers.
   */
  async logs(
    pid: number,
    after?: number,
    options?: RequestOptions,
  ): Promise<ProcessLogs> {
    return this.call(
      { operation: 'GET /processes/{pid}/logs', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.GET('/processes/{pid}/logs', {
            params: {
              path: { pid },
              query: after !== undefined ? { after } : {},
            },
            ...init,
          }),
        ),
    )
  }

  /**
   * Attaches to retained and live process output over WebSocket.
   *
   * The handle must already hold a capability token: unlike the HTTP
   * calls in this module, a handshake the agent rejects cannot be
   * distinguished from any other socket failure, so the SDK cannot
   * re-mint and reconnect on its own.
   *
   * @param pid Process ID from {@link Commands.listProcesses}.
   * @param options Sequence to resume from, handshake timeout, and signal.
   */
  attach(pid: number, options?: AttachProcessOptions): ProcessAttachment {
    const after = options?.after ?? 0
    if (!isNonNegativeInteger(after)) {
      throw new RangeError('after must be a non-negative integer')
    }
    const socket = openDataPlaneWebSocket(
      this.sandbox,
      this.agentPort,
      this.webSocket,
      `/processes/${pid}/stream`,
      { after },
    )
    return new ProcessAttachment(socket, this.streamOptions(options))
  }

  /**
   * List the processes the agent supervises inside the sandbox.
   *
   * @param options Per-call timeout, signal, and headers.
   * @returns The supervised processes.
   */
  async listProcesses(options?: RequestOptions): Promise<Process[]> {
    const page = await this.call(
      { operation: 'GET /processes', idempotent: true, options },
      async (client, init) =>
        unwrap(await client.GET('/processes', { ...init })),
    )
    return page.items
  }

  /**
   * Send a signal to a process.
   *
   * @param pid Process ID from {@link Commands.listProcesses}.
   * @param signal Signal to deliver. Defaults to `SIGTERM`.
   * @param options Per-call timeout, signal, and headers.
   */
  async kill(
    pid: number,
    signal?: Signal,
    options?: RequestOptions,
  ): Promise<void> {
    await this.call(
      { operation: 'DELETE /processes/{pid}', idempotent: true, options },
      async (client, init) =>
        unwrap(
          await client.DELETE('/processes/{pid}', {
            params: {
              path: { pid },
              query: signal !== undefined ? { signal } : {},
            },
            ...init,
          }),
        ),
    )
  }

  /** Maps per-call overrides onto a stream's connection settings. */
  private streamOptions(options?: RequestOptions): StreamOptions {
    return {
      handshakeTimeoutMs:
        options?.requestTimeoutMs ?? this.requests.requestTimeoutMs,
      ...(options?.signal !== undefined && { signal: options.signal }),
    }
  }
}
