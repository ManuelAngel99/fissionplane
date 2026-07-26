import { unwrap, type ApiClient } from './api'
import type { components } from './api/schema.gen'
import {
  RequestPipeline,
  type RequestDefaults,
  type RequestOptions,
} from './http'

/** One port's exposure record: visibility plus the port's public URL. */
export type PortExposure = components['schemas']['PortExposure']

/**
 * `'private'`: reachable with a capability token whose scope permits
 * the port — the default for every port. `'public'`: anonymous traffic
 * is admitted to this tenant application port. The server rejects its
 * reserved agent port.
 */
export type PortVisibility = components['schemas']['PortVisibility']

/**
 * Module for managing one sandbox's port exposure, available as
 * `sandbox.ports`.
 */
export class SandboxPorts {
  private readonly requests: RequestPipeline

  /**
   * Creates a port module bound to one sandbox.
   *
   * @param api Control-plane client.
   * @param sandboxId Sandbox identifier.
   * @param defaults Timeout, retry budget, and logger.
   */
  constructor(
    private readonly api: ApiClient,
    private readonly sandboxId: string,
    defaults?: RequestDefaults,
  ) {
    this.requests = new RequestPipeline(defaults)
  }

  /**
   * List the sandbox's exposure records.
   *
   * A port with no record is simply private; absence here does not mean
   * unreachable.
   *
   * @param options Per-call timeout, signal, and headers.
   * @returns The sandbox's exposure records.
   */
  async list(options?: RequestOptions): Promise<PortExposure[]> {
    const page = await this.requests.send(
      {
        operation: 'GET /v1/sandboxes/{sandboxId}/ports',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.GET('/v1/sandboxes/{sandboxId}/ports', {
            params: { path: { sandboxId: this.sandboxId } },
            ...init,
          }),
        ),
    )
    return page.items
  }

  /**
   * Record a port's exposure. Idempotent: repeating the call re-asserts
   * the record.
   *
   * @param port Port number inside the sandbox, from 1 through 65535.
   * @param visibility Access policy for the port.
   * @param options Per-call timeout, signal, and headers.
   * @returns The exposure record, including the port's public URL.
   *
   * @example
   * ```ts
   * const exposure = await sandbox.ports.expose(3000, 'public')
   * console.log(exposure.url) // https://3000-<sandboxId>.<domain>
   * ```
   */
  async expose(
    port: number,
    visibility: PortVisibility,
    options?: RequestOptions,
  ): Promise<PortExposure> {
    return this.requests.send(
      {
        operation: 'PUT /v1/sandboxes/{sandboxId}/ports/{port}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.PUT('/v1/sandboxes/{sandboxId}/ports/{port}', {
            params: { path: { sandboxId: this.sandboxId, port } },
            body: { visibility },
            ...init,
          }),
        ),
    )
  }

  /**
   * Remove a port's exposure record, returning the port to the default:
   * private, capability token required. Public traffic to the port
   * stops.
   *
   * @param port Port number whose record to remove.
   * @param options Per-call timeout, signal, and headers.
   */
  async unexpose(port: number, options?: RequestOptions): Promise<void> {
    await this.requests.send(
      {
        operation: 'DELETE /v1/sandboxes/{sandboxId}/ports/{port}',
        idempotent: true,
        options,
      },
      async (init) =>
        unwrap(
          await this.api.DELETE('/v1/sandboxes/{sandboxId}/ports/{port}', {
            params: { path: { sandboxId: this.sandboxId, port } },
            ...init,
          }),
        ),
    )
  }
}
