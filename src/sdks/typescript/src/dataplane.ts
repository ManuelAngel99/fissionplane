import type { components } from './api/schema.gen'
import { AuthenticationError, FissionPlaneError } from './errors'
import type { Logger, RequestDefaults } from './http'

/** The well-known data-plane port the sandbox agent listens on. */
export const DEFAULT_AGENT_PORT = 50000

type CapabilityToken = components['schemas']['CapabilityToken']

/** The sandbox identity and current capability token used by data-plane modules. */
export interface TokenSource {
  readonly info: { readonly sandbox_id: string; readonly domain: string }
  readonly token?: CapabilityToken
  /**
   * Mints a token for the current epoch and arms the handle with it.
   * When present, data-plane modules recover from a rejected token by
   * calling it once and replaying the request.
   */
  readonly mintToken?: () => Promise<CapabilityToken>
}

/** Minimal WebSocket surface accepted by the SDK's streaming modules. */
export interface WebSocketConnection {
  readonly protocol: string
  onOpen?: () => void
  onMessage?: (data: unknown) => void
  onClose?: () => void
  onError?: (error: unknown) => void
  send(data: string): void
  close(code?: number, reason?: string): void
}

/** Injectable WebSocket factory used by process attach and file watch. */
export type WebSocketFactory = (
  url: string,
  protocols: string[],
) => WebSocketConnection

/** How sandbox handles reach the sandbox data plane. */
export interface DataPlaneOptions extends RequestDefaults {
  /**
   * Port the sandbox agent serves the data plane on; the first label of
   * the data-plane hostname.
   *
   * @default 50000
   */
  agentPort?: number
  /** Custom fetch implementation (tests, non-Node runtimes). */
  fetch?: typeof globalThis.fetch
  /** Custom WebSocket factory (tests, runtimes without a global WebSocket). */
  webSocket?: WebSocketFactory
}

class NativeWebSocketConnection implements WebSocketConnection {
  onOpen?: () => void
  onMessage?: (data: unknown) => void
  onClose?: () => void
  onError?: (error: unknown) => void

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('open', () => this.onOpen?.())
    socket.addEventListener('message', (event) => this.onMessage?.(event.data))
    socket.addEventListener('close', () => this.onClose?.())
    socket.addEventListener('error', (event) => this.onError?.(event))
  }

  get protocol(): string {
    return this.socket.protocol
  }

  send(data: string): void {
    this.socket.send(data)
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason)
  }
}

function defaultWebSocketFactory(
  url: string,
  protocols: string[],
): WebSocketConnection {
  if (typeof globalThis.WebSocket === 'undefined') {
    throw new FissionPlaneError(
      'WebSocket is unavailable; provide DataPlaneOptions.webSocket',
    )
  }
  return new NativeWebSocketConnection(new globalThis.WebSocket(url, protocols))
}

/**
 * Runs a data-plane call, recovering once from a rejected capability
 * token by minting a fresh one and replaying the call.
 *
 * A token is scoped to a sandbox epoch and expires, so a handle that
 * has been idle can hold one the agent no longer accepts. Every
 * data-plane HTTP call in `commands` and `files` goes through here.
 *
 * WebSocket streams are not covered: the handshake's 401 reaches the
 * SDK as an opaque socket error, so `commands.attach` and `files.watch`
 * still need a token minted in advance.
 *
 * @param sandbox Source of the sandbox identity and current token.
 * @param logger Diagnostic sink for the re-mint.
 * @param run Performs the call against the current token.
 * @returns The call's result, from the first or the replayed attempt.
 */
export async function withFreshToken<T>(
  sandbox: TokenSource,
  logger: Logger,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (
      !(error instanceof AuthenticationError) ||
      sandbox.mintToken === undefined
    ) {
      throw error
    }
    logger.debug?.(
      `sandbox ${sandbox.info.sandbox_id} rejected the capability token; ` +
        'minting a fresh one and replaying the request',
    )
    await sandbox.mintToken()
    return run()
  }
}

/** Resolves the current token or raises the standard unarmed-handle error. */
export function capabilityToken(sandbox: TokenSource): string {
  const token = sandbox.token
  if (token === undefined) {
    throw new FissionPlaneError(
      `sandbox ${sandbox.info.sandbox_id} has no capability token; ` +
        'obtain one via sandboxes.create, sandbox.resume, or sandbox.mintToken',
    )
  }
  return token.token
}

/** Returns the HTTPS origin for one sandbox's data plane. */
export function dataPlaneOrigin(
  sandbox: TokenSource,
  agentPort: number,
): string {
  return `https://${agentPort}-${sandbox.info.sandbox_id}.${sandbox.info.domain}`
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

/** Opens an authenticated data-plane WebSocket using protocol credentials. */
export function openDataPlaneWebSocket(
  sandbox: TokenSource,
  agentPort: number,
  factory: WebSocketFactory | undefined,
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): WebSocketConnection {
  const token = capabilityToken(sandbox)
  const url = new URL(path, dataPlaneOrigin(sandbox, agentPort))
  url.protocol = 'wss:'
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(name, String(value))
  }
  return (factory ?? defaultWebSocketFactory)(url.toString(), [
    'fissionplane.v1',
    `fissionplane.token.${base64Url(token)}`,
  ])
}
