/**
 * fissionplane TypeScript SDK.
 *
 * ```ts
 * const client = new FissionPlane({ apiKey: process.env.FISSIONPLANE_API_KEY })
 * const sandbox = await client.sandboxes.create({ template: 'base' })
 * const result = await sandbox.commands.run('echo', { args: ['hello'] })
 * await sandbox.pause()
 * ```
 *
 * Every request carries the SDK's `User-Agent`, aborts after
 * `requestTimeoutMs`, and — when replaying it is safe — is retried with
 * jittered exponential backoff. Any call accepts its own
 * {@link RequestOptions} to override the timeout, pass an `AbortSignal`,
 * or add headers.
 *
 * The API cores under `src/api/schema.gen.ts` (control plane) and
 * `src/dataplane/schema.gen.ts` (data plane) are generated from
 * `src/contracts/openapi.yaml` and `src/contracts/dataplane.yaml` (`pnpm run generate`)
 * and never edited by hand.
 */

import { createApiClient, type ApiClient, type ConnectionConfig } from './api'
import type { WebSocketFactory } from './dataplane'
import { AuthenticationError } from './errors'
import type { RequestDefaults } from './http'
import { Sandboxes } from './sandbox'
import { Templates } from './templates'

/** Options for constructing an {@link FissionPlane} client. */
export interface FissionPlaneOptions extends RequestDefaults {
  /**
   * Organisation API key, sent as `X-API-Key`.
   *
   * @default process.env.FISSIONPLANE_API_KEY
   */
  apiKey?: string
  /** OIDC bearer token; used when no API key is given. */
  accessToken?: string
  /**
   * Control-plane base URL.
   *
   * @default process.env.FISSIONPLANE_API_URL
   */
  baseUrl?: string
  /**
   * Port the sandbox agent serves the data plane on; the first label of
   * the data-plane hostname `https://<agentPort>-<sandboxId>.<domain>`.
   *
   * @default 50000
   */
  agentPort?: number
  /** Custom fetch implementation (tests, non-Node runtimes). */
  fetch?: typeof globalThis.fetch
  /** Custom WebSocket factory (tests, runtimes without a global WebSocket). */
  webSocket?: WebSocketFactory
}

/**
 * Rejects a credential that cannot be sent as an HTTP header value.
 *
 * The SDK deliberately assumes no credential format beyond that: a
 * server decides what a valid key is.
 */
function checkCredential(
  value: string,
  option: 'apiKey' | 'accessToken',
): void {
  if (value.length > 0 && !/\s/u.test(value)) return
  const fault =
    value.length === 0 ? 'empty' : 'not a single token: it contains whitespace'
  throw new AuthenticationError(
    `${option} is ${fault}; pass one as ` +
      `new FissionPlane({ ${option}: '…' })` +
      (option === 'apiKey'
        ? ' or set FISSIONPLANE_API_KEY in the environment'
        : ''),
    undefined,
    'invalid_credential',
  )
}

/**
 * The entry point: one client per credential and control plane.
 *
 * @example
 * ```ts
 * import { FissionPlane } from '@fissionplane/sdk'
 *
 * const client = new FissionPlane({ apiKey: process.env.FISSIONPLANE_API_KEY })
 * const sandbox = await client.sandboxes.create({ template: 'base' })
 * console.log(sandbox.hostname(3000))
 * ```
 */
export class FissionPlane {
  /** Sandbox lifecycle, credentials, and the per-sandbox modules. */
  readonly sandboxes: Sandboxes
  /** The template registry and template builds. */
  readonly templates: Templates
  /** The typed low-level client, for operations the ergonomic layer does not wrap. */
  readonly api: ApiClient

  /**
   * Creates an SDK client.
   *
   * @param options Authentication and connection settings.
   * @throws {AuthenticationError} When a resolved credential is empty
   *   or carries whitespace.
   */
  constructor(options: FissionPlaneOptions = {}) {
    const env = typeof process !== 'undefined' ? process.env : {}
    const apiKey = options.apiKey ?? env['FISSIONPLANE_API_KEY']
    if (apiKey !== undefined) checkCredential(apiKey, 'apiKey')
    if (options.accessToken !== undefined) {
      checkCredential(options.accessToken, 'accessToken')
    }

    const defaults: RequestDefaults = {
      ...(options.requestTimeoutMs !== undefined && {
        requestTimeoutMs: options.requestTimeoutMs,
      }),
      ...(options.maxRetries !== undefined && {
        maxRetries: options.maxRetries,
      }),
      ...(options.logger !== undefined && { logger: options.logger }),
    }
    const config: ConnectionConfig = {
      apiKey,
      accessToken: options.accessToken,
      baseUrl:
        options.baseUrl ??
        env['FISSIONPLANE_API_URL'] ??
        'https://api.example.com',
      fetch: options.fetch,
      ...defaults,
    }
    this.api = createApiClient(config)
    this.sandboxes = new Sandboxes(this.api, {
      agentPort: options.agentPort,
      fetch: options.fetch,
      webSocket: options.webSocket,
      ...defaults,
    })
    this.templates = new Templates(this.api, defaults)
  }
}

export type { ApiClient, ConnectionConfig } from './api'
export { sdkVersion, userAgent, defaultHeaders } from './api/metadata'
export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestPipeline,
} from './http'
export type {
  CallInit,
  CallSpec,
  Logger,
  RequestDefaults,
  RequestOptions,
} from './http'
export { Sandbox, Sandboxes } from './sandbox'
export type {
  SandboxInfo,
  CapabilityToken,
  CreateSandboxRequest,
  CreateSandboxOptions,
  MintTokenOptions,
  ResumeSandboxOptions,
  SandboxState,
  ListSandboxesOptions,
} from './sandbox'
export { SandboxPorts } from './ports'
export type { PortExposure, PortVisibility } from './ports'
export { Commands, ProcessAttachment, ProcessHandle } from './commands'
export type {
  CommandResult,
  Process,
  ProcessLogs,
  PtySize,
  Signal,
  RunCommandOptions,
  StartProcessOptions,
  AttachProcessOptions,
  ProcessStreamEvent,
} from './commands'
export { DEFAULT_AGENT_PORT } from './dataplane'
export type {
  DataPlaneOptions,
  TokenSource,
  WebSocketConnection,
  WebSocketFactory,
} from './dataplane'
export { FileWatch, SandboxFiles } from './files'
export type {
  FileInfo,
  FileKind,
  FileWatchEvent,
  MakeDirectoryOptions,
  MoveFileOptions,
  RemoveFileOptions,
  WatchFilesOptions,
  WriteFileOptions,
} from './files'
export { StreamingProtocolError } from './streaming'
export type { StreamOptions } from './streaming'
export { Templates, TemplateBuild } from './templates'
export type {
  Template,
  CreateTemplateBuildRequest,
  BuildStep,
  ListTemplatesOptions,
  TemplateBuildInfo,
  TemplateBuildStatus,
  TemplateBuildLogEntry,
  WaitForBuildOptions,
} from './templates'
export {
  FissionPlaneError,
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  SnapshotExpiredError,
  RateLimitError,
  CommandTimeoutError,
  TemplateBuildError,
} from './errors'
export type { paths, components } from './api/schema.gen'
export type {
  paths as dataplanePaths,
  components as dataplaneComponents,
} from './dataplane/schema.gen'
