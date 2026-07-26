import { unwrap, type ApiClient } from './api'
import type { components } from './api/schema.gen'
import { Commands } from './commands'
import type { DataPlaneOptions } from './dataplane'
import { SandboxFiles } from './files'
import { RequestPipeline, type RequestOptions } from './http'
import { SandboxPorts } from './ports'

/** The control plane's representation of one sandbox. */
export type SandboxInfo = components['schemas']['Sandbox']

/** A scoped, expiring bearer credential for the sandbox data plane. */
export type CapabilityToken = components['schemas']['CapabilityToken']

/** Payload for {@link Sandboxes.create}. */
export type CreateSandboxRequest = components['schemas']['CreateSandboxRequest']

/** A tenant-visible sandbox lifecycle state. */
export type SandboxState = components['schemas']['SandboxState']

/** Options for {@link Sandboxes.create}. */
export interface CreateSandboxOptions extends RequestOptions {
  /**
   * Key that makes retries return the original sandbox. Supplying one
   * also lets the SDK replay the create after a retryable failure.
   */
  idempotencyKey?: string
}

/** Options for {@link Sandbox.resume}. */
export interface ResumeSandboxOptions extends RequestOptions {
  /** Lease length from now, in seconds. */
  deadlineSeconds?: number
}

/** Options for {@link Sandbox.mintToken}. */
export interface MintTokenOptions extends RequestOptions {
  /** Requested token lifetime, in seconds. */
  ttlSeconds?: number
  /** Ports the token may access. */
  ports?: number[]
}

/** Filters and paging for {@link Sandboxes.list}. */
export interface ListSandboxesOptions extends RequestOptions {
  /** Keep only sandboxes in this state. */
  state?: SandboxState
  /** Exact match on the tenant-assigned name. */
  name?: string
  /** Matches sandboxes carrying every one of these metadata pairs. */
  metadata?: Record<string, string>
  /**
   * Page size.
   *
   * @default 20
   */
  limit?: number
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string
}

/**
 * A live handle on one sandbox: the latest known representation, the
 * capability token for the current epoch, and the modules that operate
 * on the sandbox.
 *
 * @example
 * ```ts
 * const sandbox = await client.sandboxes.create({ template: 'base' })
 * const result = await sandbox.commands.run('echo', { args: ['hello'] })
 * await sandbox.ports.expose(3000, 'public')
 * await sandbox.pause()
 * ```
 */
export class Sandbox {
  /** Port exposure records for this sandbox, on the control plane. */
  readonly ports: SandboxPorts
  /** Command execution inside this sandbox, on the data plane. */
  readonly commands: Commands
  /** Filesystem access inside this sandbox, on the data plane. */
  readonly files: SandboxFiles

  private readonly requests: RequestPipeline

  /**
   * Creates a handle for a sandbox representation.
   *
   * @param api Control-plane client.
   * @param info Current sandbox representation.
   * @param token Capability token for the current epoch, when available.
   * @param options Data-plane connection settings and request defaults.
   */
  constructor(
    private readonly api: ApiClient,
    public info: SandboxInfo,
    public token?: CapabilityToken,
    options?: DataPlaneOptions,
  ) {
    this.requests = new RequestPipeline(options)
    this.ports = new SandboxPorts(api, info.sandbox_id, options)
    this.commands = new Commands(this, options)
    this.files = new SandboxFiles(this, options)
  }

  /** Returns the sandbox identifier. */
  get sandboxId(): string {
    return this.info.sandbox_id
  }

  /**
   * The public hostname of a published port.
   *
   * @param port Port number inside the sandbox.
   * @returns The hostname `<port>-<sandboxId>.<domain>`.
   */
  hostname(port: number): string {
    return `${port}-${this.info.sandbox_id}.${this.info.domain}`
  }

  /**
   * Re-read the sandbox from the control plane.
   *
   * @param options Per-call timeout, signal, and headers.
   * @returns The sandbox's current representation.
   */
  async refresh(options?: RequestOptions): Promise<SandboxInfo> {
    this.info = await this.requests.send(
      {
        operation: 'GET /v1/sandboxes/{sandboxId}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/sandboxes/{sandboxId}', {
            params: { path: { sandboxId: this.sandboxId } },
            ...init,
          }),
        ),
    )
    return this.info
  }

  /**
   * Snapshot the sandbox and release its node capacity.
   *
   * The snapshot's upload continues in the background;
   * `restorable_until` on the returned representation records how long
   * it stays restorable.
   *
   * @param options Per-call timeout, signal, and headers.
   * @returns The paused sandbox.
   */
  async pause(options?: RequestOptions): Promise<SandboxInfo> {
    this.info = await this.requests.send(
      {
        operation: 'POST /v1/sandboxes/{sandboxId}/pause',
        idempotent: false,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.POST('/v1/sandboxes/{sandboxId}/pause', {
            params: { path: { sandboxId: this.sandboxId } },
            ...init,
          }),
        ),
    )
    return this.info
  }

  /**
   * Restore the snapshot onto a node. The resumed instance has a new
   * epoch, so the handle's token is replaced by the fresh one the
   * operation returns.
   *
   * @param options Options for the resumed sandbox.
   * @param options.deadlineSeconds Lease length from now, in seconds.
   * @returns The running sandbox under its new epoch.
   */
  async resume(options?: ResumeSandboxOptions): Promise<SandboxInfo> {
    const result = await this.requests.send(
      {
        operation: 'POST /v1/sandboxes/{sandboxId}/resume',
        idempotent: false,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.POST('/v1/sandboxes/{sandboxId}/resume', {
            params: { path: { sandboxId: this.sandboxId } },
            body:
              options?.deadlineSeconds !== undefined
                ? { deadline_seconds: options.deadlineSeconds }
                : {},
            ...init,
          }),
        ),
    )
    this.info = result.sandbox
    this.token = result.token
    return this.info
  }

  /**
   * Set the deadline to now plus `deadlineSeconds`, bounded by the
   * installation's maximum lease.
   *
   * @param deadlineSeconds New lease length from now, in seconds.
   * @param options Per-call timeout, signal, and headers.
   * @returns The sandbox with its new deadline.
   */
  async extendDeadline(
    deadlineSeconds: number,
    options?: RequestOptions,
  ): Promise<SandboxInfo> {
    this.info = await this.requests.send(
      {
        operation: 'POST /v1/sandboxes/{sandboxId}/deadline',
        idempotent: false,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.POST('/v1/sandboxes/{sandboxId}/deadline', {
            params: { path: { sandboxId: this.sandboxId } },
            body: { deadline_seconds: deadlineSeconds },
            ...init,
          }),
        ),
    )
    return this.info
  }

  /**
   * Mint a capability token for the current epoch and arm the handle
   * with it. Pass `ports` to mint an attenuated token (a scope can only
   * narrow), suitable for handing to a browser.
   *
   * Data-plane calls made through `commands` and `files` call this on
   * their own when the agent rejects the current token.
   *
   * @param options Token constraints.
   * @param options.ttlSeconds Requested token lifetime.
   * @param options.ports Ports the token may access.
   * @returns The fresh token.
   */
  async mintToken(options?: MintTokenOptions): Promise<CapabilityToken> {
    const token = await this.requests.send(
      {
        operation: 'POST /v1/sandboxes/{sandboxId}/token',
        idempotent: false,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.POST('/v1/sandboxes/{sandboxId}/token', {
            params: { path: { sandboxId: this.sandboxId } },
            body: {
              ...(options?.ttlSeconds !== undefined && {
                ttl_seconds: options.ttlSeconds,
              }),
              ...(options?.ports !== undefined && { ports: options.ports }),
            },
            ...init,
          }),
        ),
    )
    this.token = token
    return token
  }

  /**
   * Terminate the sandbox. The record remains readable as `terminated`.
   *
   * @param options Per-call timeout, signal, and headers.
   */
  async delete(options?: RequestOptions): Promise<void> {
    await this.requests.send(
      {
        operation: 'DELETE /v1/sandboxes/{sandboxId}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.DELETE('/v1/sandboxes/{sandboxId}', {
            params: { path: { sandboxId: this.sandboxId } },
            ...init,
          }),
        ),
    )
  }
}

/** Operations on the sandbox collection, available as `client.sandboxes`. */
export class Sandboxes {
  private readonly requests: RequestPipeline

  /**
   * Creates the sandbox collection module.
   *
   * @param api Control-plane client.
   * @param options Data-plane connection settings and request defaults.
   */
  constructor(
    private readonly api: ApiClient,
    private readonly options?: DataPlaneOptions,
  ) {
    this.requests = new RequestPipeline(options)
  }

  /**
   * Create a sandbox and block until a node has acknowledged it.
   *
   * @param request Sandbox configuration.
   * @param options Request options.
   * @param options.idempotencyKey Key that makes retries return the original sandbox.
   * @returns A handle armed with the minted capability token.
   *
   * @example
   * ```ts
   * const sandbox = await client.sandboxes.create(
   *   { template: 'base', metadata: { run: '42' } },
   *   { idempotencyKey: 'run-42' }
   * )
   * ```
   */
  async create(
    request: CreateSandboxRequest,
    options?: CreateSandboxOptions,
  ): Promise<Sandbox> {
    const result = await this.requests.send(
      {
        operation: 'POST /v1/sandboxes',
        // Replaying a create is only safe when the key deduplicates it.
        idempotent: options?.idempotencyKey !== undefined,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.POST('/v1/sandboxes', {
            params: {
              header:
                options?.idempotencyKey !== undefined
                  ? { 'Idempotency-Key': options.idempotencyKey }
                  : {},
            },
            body: request,
            ...init,
          }),
        ),
    )
    return new Sandbox(this.api, result.sandbox, result.token, this.options)
  }

  /**
   * Fetch one sandbox by identifier.
   *
   * The handle carries no token — a plain read must not mint
   * credentials. Call `mintToken` on the handle to reach the data
   * plane.
   *
   * @param sandboxId Sandbox identifier.
   * @param options Per-call timeout, signal, and headers.
   * @returns An unarmed handle on the sandbox.
   */
  async get(sandboxId: string, options?: RequestOptions): Promise<Sandbox> {
    const info = await this.requests.send(
      {
        operation: 'GET /v1/sandboxes/{sandboxId}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/sandboxes/{sandboxId}', {
            params: { path: { sandboxId } },
            ...init,
          }),
        ),
    )
    return new Sandbox(this.api, info, undefined, this.options)
  }

  /**
   * One page of sandboxes; see {@link Sandboxes.iterate} for the whole
   * collection.
   *
   * @param options Filters, paging, and per-call request overrides.
   * @returns One page of handles and the cursor for the next page.
   */
  async list(
    options?: ListSandboxesOptions,
  ): Promise<{ items: Sandbox[]; nextCursor?: string }> {
    const metadata =
      options?.metadata !== undefined
        ? new URLSearchParams(options.metadata).toString()
        : undefined
    const page = await this.requests.send(
      { operation: 'GET /v1/sandboxes', idempotent: true, options },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/sandboxes', {
            params: {
              query: {
                ...(options?.state !== undefined && { state: options.state }),
                ...(options?.name !== undefined && { name: options.name }),
                ...(metadata !== undefined && { metadata }),
                ...(options?.limit !== undefined && { limit: options.limit }),
                ...(options?.cursor !== undefined && {
                  cursor: options.cursor,
                }),
              },
            },
            ...init,
          }),
        ),
    )
    return {
      items: page.items.map(
        (info) => new Sandbox(this.api, info, undefined, this.options),
      ),
      nextCursor: page.next_cursor ?? undefined,
    }
  }

  /**
   * Walk every page of the collection, following each page's
   * `nextCursor` until the collection is exhausted.
   *
   * @param options Filters and per-call request overrides applied to every page.
   * @returns Sandboxes across all matching pages.
   *
   * @example
   * ```ts
   * for await (const sandbox of client.sandboxes.iterate({ state: 'running' })) {
   *   console.log(sandbox.sandboxId)
   * }
   * ```
   */
  async *iterate(
    options?: Omit<ListSandboxesOptions, 'cursor'>,
  ): AsyncGenerator<Sandbox> {
    let cursor: string | undefined
    let pageNumber = 0
    do {
      const page = await this.list({ ...options, cursor })
      pageNumber += 1
      this.requests.logger.debug?.(
        `sandboxes.iterate fetched page ${pageNumber} ` +
          `(${page.items.length} sandboxes, ` +
          `${page.nextCursor !== undefined ? 'more follow' : 'last page'})`,
      )
      yield* page.items
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }
}
