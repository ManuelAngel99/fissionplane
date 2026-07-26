import { unwrap, type ApiClient } from './api'
import type { components } from './api/schema.gen'
import { FissionPlaneError, TemplateBuildError } from './errors'
import {
  RequestPipeline,
  type RequestDefaults,
  type RequestOptions,
} from './http'

/** A registry record: a mutable alias pointing at an immutable artifact. */
export type Template = components['schemas']['Template']

/** Payload for {@link Templates.build}. */
export type CreateTemplateBuildRequest =
  components['schemas']['CreateTemplateBuildRequest']

/** One recipe step, executed in order inside the build VM. */
export type BuildStep = components['schemas']['BuildStep']

/** The control plane's representation of one template build. */
export type TemplateBuildInfo = components['schemas']['TemplateBuild']

/** `queued` and `building` are in progress; `succeeded` and `failed` are terminal. */
export type TemplateBuildStatus = components['schemas']['TemplateBuildStatus']

/** One timestamped line of build output. */
export type TemplateBuildLogEntry =
  components['schemas']['TemplateBuildLogEntry']

/** Options for {@link Templates.list}. */
export interface ListTemplatesOptions extends RequestOptions {
  /** Page size. */
  limit?: number
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string
}

/** Options for {@link TemplateBuild.wait}. */
export interface WaitForBuildOptions extends RequestOptions {
  /**
   * Delay between polls, in milliseconds.
   *
   * @default 2000
   */
  pollIntervalMs?: number
  /**
   * Give up after this many milliseconds. `wait` then throws, but the
   * build itself keeps running server-side.
   */
  timeoutMs?: number
}

/** Waits for the requested polling interval. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A live handle on one template build. The create returns as soon as
 * the build is queued; this handle carries the polling loop.
 *
 * @example
 * ```ts
 * const build = await client.templates.build({ image: 'python:3.12', alias: 'py' })
 * const info = await build.wait()
 * console.log(info.artifact_id)
 * ```
 */
export class TemplateBuild {
  private readonly requests: RequestPipeline

  /**
   * Creates a handle for a template build.
   *
   * @param api Control-plane client.
   * @param info Current build representation.
   * @param sleep Polling delay implementation.
   * @param defaults Timeout, retry budget, and logger.
   */
  constructor(
    private readonly api: ApiClient,
    public info: TemplateBuildInfo,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
    defaults?: RequestDefaults,
  ) {
    this.requests = new RequestPipeline(defaults)
  }

  /** Returns the template build identifier. */
  get buildId(): string {
    return this.info.build_id
  }

  /**
   * Re-read the build from the control plane.
   *
   * @param options Per-call timeout, signal, and headers.
   * @returns The build's current representation.
   */
  async refresh(options?: RequestOptions): Promise<TemplateBuildInfo> {
    this.info = await this.requests.send(
      {
        operation: 'GET /v1/templates/builds/{buildId}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/templates/builds/{buildId}', {
            params: { path: { buildId: this.buildId } },
            ...init,
          }),
        ),
    )
    return this.info
  }

  /**
   * Read one page of build logs.
   *
   * A call at the current end returns an empty page, not an error, so
   * tailing a live build and reading a finished one are the same loop.
   *
   * @param offset Entry offset from which to read.
   * @param options Per-call timeout, signal, and headers.
   * @returns Log entries and the next offset.
   */
  async logs(
    offset?: number,
    options?: RequestOptions,
  ): Promise<{
    entries: TemplateBuildLogEntry[]
    nextOffset: number
  }> {
    const page = await this.requests.send(
      {
        operation: 'GET /v1/templates/builds/{buildId}/logs',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/templates/builds/{buildId}/logs', {
            params: {
              path: { buildId: this.buildId },
              query: offset !== undefined ? { offset } : {},
            },
            ...init,
          }),
        ),
    )
    return { entries: page.entries, nextOffset: page.next_offset }
  }

  /**
   * Poll until the build reaches a terminal status.
   *
   * @param options Polling interval and timeout.
   * @returns The successful terminal representation.
   * @throws {TemplateBuildError} When the build fails.
   * @throws {FissionPlaneError} When `timeoutMs` elapses first.
   *
   * @example
   * ```ts
   * const info = await build.wait({ timeoutMs: 10 * 60 * 1000 })
   * ```
   */
  async wait(options?: WaitForBuildOptions): Promise<TemplateBuildInfo> {
    const pollIntervalMs = options?.pollIntervalMs ?? 2000
    const timeoutMs = options?.timeoutMs
    const deadline =
      timeoutMs !== undefined ? Date.now() + timeoutMs : undefined

    for (;;) {
      const info = await this.refresh(options)
      if (info.status === 'succeeded') return info
      if (info.status === 'failed') {
        throw new TemplateBuildError(
          `template build ${info.build_id} failed: ${info.error ?? 'no error reported'}`,
          info.error ?? undefined,
        )
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new FissionPlaneError(
          `template build ${info.build_id} did not reach a terminal status ` +
            `within ${timeoutMs}ms (last status: ${info.status}); the build ` +
            'keeps running — call wait() or refresh() again',
        )
      }
      await this.sleep(pollIntervalMs)
    }
  }
}

/**
 * Module for the template registry and its builds, available as
 * `client.templates`.
 */
export class Templates {
  private readonly requests: RequestPipeline

  /**
   * Creates the template registry module.
   *
   * @param api Control-plane client.
   * @param defaults Timeout, retry budget, and logger.
   */
  constructor(
    private readonly api: ApiClient,
    private readonly defaults?: RequestDefaults,
  ) {
    this.requests = new RequestPipeline(defaults)
  }

  /**
   * List templates visible to the organisation.
   *
   * @param options Paging and per-call request overrides.
   * @returns One page of templates and the cursor for the next page.
   */
  async list(
    options?: ListTemplatesOptions,
  ): Promise<{ items: Template[]; nextCursor?: string }> {
    const page = await this.requests.send(
      { operation: 'GET /v1/templates', idempotent: true, options },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/templates', {
            params: {
              query: {
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
    return { items: page.items, nextCursor: page.next_cursor ?? undefined }
  }

  /**
   * Resolve a template alias or ID to its current record.
   *
   * Aliases are mutable: reading a template and creating from it can
   * observe different artifacts if the alias is re-pointed in between.
   *
   * @param template Template alias or identifier.
   * @param options Per-call timeout, signal, and headers.
   * @returns The template record.
   */
  async get(template: string, options?: RequestOptions): Promise<Template> {
    return this.requests.send(
      { operation: 'GET /v1/templates/{template}', idempotent: true, options },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/templates/{template}', {
            params: { path: { template } },
            ...init,
          }),
        ),
    )
  }

  /**
   * Start a template build from an OCI image reference and a recipe.
   *
   * Asynchronous: the call returns as soon as the build is queued. Use
   * {@link TemplateBuild.wait} for the outcome and
   * {@link TemplateBuild.logs} to tail output.
   *
   * @param request Image, optional alias, and build recipe.
   * @param options Per-call timeout, signal, and headers.
   * @returns A handle on the queued build.
   *
   * @example
   * ```ts
   * const build = await client.templates.build({
   *   image: 'python:3.12',
   *   alias: 'py-flask',
   *   steps: [{ command: 'pip install flask' }],
   *   start_command: 'python /app/server.py',
   * })
   * await build.wait()
   * const sandbox = await client.sandboxes.create({ template: 'py-flask' })
   * ```
   */
  async build(
    request: CreateTemplateBuildRequest,
    options?: RequestOptions,
  ): Promise<TemplateBuild> {
    const info = await this.requests.send(
      {
        operation: 'POST /v1/templates/builds',
        idempotent: false,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.POST('/v1/templates/builds', {
            body: request,
            ...init,
          }),
        ),
    )
    return new TemplateBuild(this.api, info, undefined, this.defaults)
  }

  /**
   * Fetch one build by identifier.
   *
   * @param buildId Template build identifier.
   * @param options Per-call timeout, signal, and headers.
   * @returns A handle on the build.
   */
  async getBuild(
    buildId: string,
    options?: RequestOptions,
  ): Promise<TemplateBuild> {
    const info = await this.requests.send(
      {
        operation: 'GET /v1/templates/builds/{buildId}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/templates/builds/{buildId}', {
            params: { path: { buildId } },
            ...init,
          }),
        ),
    )
    return new TemplateBuild(this.api, info, undefined, this.defaults)
  }

  /**
   * Retire a template record and its alias.
   *
   * Existing sandboxes created from the artifact are unaffected; the
   * artifact's bytes are collected once nothing references them.
   *
   * @param template Template alias or identifier.
   * @param options Per-call timeout, signal, and headers.
   */
  async delete(template: string, options?: RequestOptions): Promise<void> {
    await this.requests.send(
      {
        operation: 'DELETE /v1/templates/{template}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.DELETE('/v1/templates/{template}', {
            params: { path: { template } },
            ...init,
          }),
        ),
    )
  }
}
