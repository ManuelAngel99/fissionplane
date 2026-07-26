import { describe, expect, test } from 'vitest'

import { AuthenticationError, type FissionPlaneOptions } from '../src/index'
import {
  fakeWebSocketFactory,
  jsonResponse,
  makeClient,
  sandboxBody,
  tokenBody,
  type FakeWebSocket,
} from './helpers'

function isDataPlane(url: URL): boolean {
  return url.hostname.endsWith('.sandboxes.example.com')
}

/**
 * A client whose data plane rejects its first `rejections` calls with a
 * 401, and whose control plane mints a token for a new epoch each time
 * it is asked.
 */
function reArmingClient(
  rejections: number,
  onDataPlane: (request: Request) => Response,
  options: Partial<FissionPlaneOptions> = {},
) {
  const tokensSeen: Array<string | null> = []
  let mints = 0
  let calls = 0
  const client = makeClient((request) => {
    const url = new URL(request.url)
    if (isDataPlane(url)) {
      tokensSeen.push(request.headers.get('X-Sandbox-Token'))
      calls += 1
      if (calls <= rejections) {
        return jsonResponse(401, {
          code: 'token_expired',
          message: 'capability token is no longer valid',
        })
      }
      return onDataPlane(request)
    }
    if (url.pathname === '/v1/sandboxes/abc123/token') {
      mints += 1
      return jsonResponse(200, tokenBody(mints + 1))
    }
    return jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody(1) })
  }, options)
  return { client, tokensSeen, mints: () => mints }
}

describe('capability token refresh', () => {
  test('a rejected command re-mints once and replays with the new token', async () => {
    const { client, tokensSeen, mints } = reArmingClient(1, () =>
      jsonResponse(200, { exit_code: 0, stdout: 'ok\n', stderr: '' }),
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const result = await sandbox.commands.run('true')

    expect(result.stdout).toBe('ok\n')
    expect(tokensSeen).toEqual(['cap-epoch-1', 'cap-epoch-2'])
    expect(mints()).toBe(1)
    expect(sandbox.token?.token).toBe('cap-epoch-2')
  })

  test('the re-mint is logged', async () => {
    const lines: string[] = []
    const { client } = reArmingClient(
      1,
      () => jsonResponse(200, { exit_code: 0, stdout: '', stderr: '' }),
      { logger: { debug: (message) => lines.push(message) } },
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.commands.run('true')

    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/sandbox abc123 rejected the capability token/u)
  })

  test('a rejected file download re-mints and replays', async () => {
    const { client, tokensSeen, mints } = reArmingClient(
      1,
      () => new Response(Uint8Array.from([7, 8, 9])),
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const bytes = await sandbox.files.read('/workspace/a.bin')

    expect([...bytes]).toEqual([7, 8, 9])
    expect(tokensSeen).toEqual(['cap-epoch-1', 'cap-epoch-2'])
    expect(mints()).toBe(1)
  })

  test('a persistently rejected call re-mints exactly once and then fails', async () => {
    const { client, tokensSeen, mints } = reArmingClient(99, () =>
      jsonResponse(200, { items: [] }),
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })

    await expect(sandbox.files.list('/workspace')).rejects.toBeInstanceOf(
      AuthenticationError,
    )
    expect(tokensSeen).toEqual(['cap-epoch-1', 'cap-epoch-2'])
    expect(mints()).toBe(1)
  })
})

describe('stream handshake', () => {
  test('a handshake that never completes fails with a timeout', async () => {
    const seen: { socket?: FakeWebSocket } = {}
    const client = makeClient(
      () => jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() }),
      { webSocket: fakeWebSocketFactory(seen) },
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const attachment = sandbox.commands.attach(42, { requestTimeoutMs: 20 })
    const event = attachment[Symbol.asyncIterator]().next()

    await expect(event).rejects.toThrow(/handshake did not complete/u)
    expect(seen.socket?.closed).toBe(true)
  })

  test('a signal closes an open watch', async () => {
    const seen: { socket?: FakeWebSocket } = {}
    const controller = new AbortController()
    const client = makeClient(
      () => jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() }),
      { webSocket: fakeWebSocketFactory(seen) },
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const watch = sandbox.files.watch('/workspace', {
      signal: controller.signal,
    })
    seen.socket?.open()
    const event = watch[Symbol.asyncIterator]().next()
    controller.abort()

    await expect(event).resolves.toEqual({ value: undefined, done: true })
    expect(seen.socket?.closed).toBe(true)
  })
})
