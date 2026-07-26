import {
  FissionPlane,
  type FissionPlaneOptions,
  type WebSocketConnection,
  type WebSocketFactory,
} from '../src/index'

/**
 * Creates a sandbox response fixture.
 *
 * @param sandboxId Sandbox identifier.
 * @param epoch Sandbox epoch.
 * @param overrides Fields to replace in the fixture.
 * @returns A sandbox response body.
 */
export function sandboxBody(
  sandboxId = 'abc123',
  epoch = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    sandbox_id: sandboxId,
    state: 'running',
    template_artifact_id: 'art1',
    epoch,
    domain: 'sandboxes.example.com',
    created_at: '2026-07-28T12:00:00Z',
    deadline: '2026-07-28T13:00:00Z',
    resources: { vcpus: 2, mem_mib: 1024 },
    metadata: {},
    ...overrides,
  }
}

/**
 * Creates a capability-token response fixture.
 *
 * @param epoch Token epoch.
 * @returns A capability-token response body.
 */
export function tokenBody(epoch = 1) {
  return {
    token: `cap-epoch-${epoch}`,
    expires_at: '2026-07-28T12:30:00Z',
    epoch,
  }
}

/**
 * Creates a JSON response for a test handler.
 *
 * @param status HTTP status.
 * @param body Optional response body.
 * @returns A response with JSON headers when a body is present.
 */
export function jsonResponse(status: number, body?: unknown): Response {
  if (body === undefined) return new Response(null, { status })
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export type Handler = (request: Request) => Response | Promise<Response>

/**
 * Creates an SDK client backed by a test request handler.
 *
 * @param handler Handler for every outgoing request.
 * @param options Client settings to override.
 * @returns A configured SDK client.
 */
export function makeClient(
  handler: Handler,
  options: Partial<FissionPlaneOptions> = {},
): FissionPlane {
  const fakeFetch: typeof fetch = async (input, init) =>
    handler(new Request(input, init))
  return new FissionPlane({
    apiKey: 'key123',
    baseUrl: 'http://control-plane.test',
    fetch: fakeFetch,
    ...options,
  })
}

export class FakeWebSocket implements WebSocketConnection {
  onOpen?: () => void
  onMessage?: (data: unknown) => void
  onClose?: () => void
  onError?: (error: unknown) => void
  readonly sent: string[] = []
  closed = false

  constructor(readonly protocol = 'fissionplane.v1') {}

  open(): void {
    this.onOpen?.()
  }

  receive(data: unknown): void {
    this.onMessage?.(data)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.onClose?.()
  }
}

export function fakeWebSocketFactory(seen: {
  url?: string
  protocols?: string[]
  socket?: FakeWebSocket
}): WebSocketFactory {
  return (url, protocols) => {
    const socket = new FakeWebSocket()
    seen.url = url
    seen.protocols = protocols
    seen.socket = socket
    return socket
  }
}
