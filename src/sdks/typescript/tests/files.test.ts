import { describe, expect, test } from 'vitest'

import type { FissionPlaneOptions } from '../src/index'
import {
  type FakeWebSocket,
  fakeWebSocketFactory,
  jsonResponse,
  makeClient,
  sandboxBody,
  tokenBody,
  type Handler,
} from './helpers'

function filesClient(
  onDataPlane: Handler,
  options: Partial<FissionPlaneOptions> = {},
) {
  return makeClient(async (request) => {
    const url = new URL(request.url)
    if (!url.hostname.endsWith('.sandboxes.example.com')) {
      return jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() })
    }
    return onDataPlane(request)
  }, options)
}

describe('files', () => {
  test('lists, stats, creates, moves, and removes paths', async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = []
    const client = filesClient(async (request) => {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        url: request.url,
        body: request.method === 'POST' ? await request.json() : undefined,
      })
      if (url.pathname === '/files/stat') {
        return jsonResponse(200, {
          path: '/workspace/a.txt',
          name: 'a.txt',
          kind: 'file',
          size: 3,
          mode: '0644',
          modified_at: '2026-07-28T12:00:00Z',
        })
      }
      if (request.method === 'GET') {
        return jsonResponse(200, {
          items: [
            {
              path: '/workspace/a.txt',
              name: 'a.txt',
              kind: 'file',
              size: 3,
              mode: '0644',
              modified_at: '2026-07-28T12:00:00Z',
            },
          ],
        })
      }
      return jsonResponse(204)
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    expect(await sandbox.files.list('/workspace')).toHaveLength(1)
    expect((await sandbox.files.stat('/workspace/a.txt')).size).toBe(3)
    await sandbox.files.makeDir('/workspace/nested', {
      parents: false,
      mode: '0750',
    })
    await sandbox.files.move('/workspace/a.txt', '/workspace/b.txt', {
      overwrite: true,
    })
    await sandbox.files.remove('/workspace/nested', { recursive: true })

    expect(requests).toEqual([
      {
        method: 'GET',
        url: 'https://50000-abc123.sandboxes.example.com/files?path=%2Fworkspace',
      },
      {
        method: 'GET',
        url: 'https://50000-abc123.sandboxes.example.com/files/stat?path=%2Fworkspace%2Fa.txt',
      },
      {
        method: 'POST',
        url: 'https://50000-abc123.sandboxes.example.com/files/directories',
        body: { path: '/workspace/nested', parents: false, mode: '0750' },
      },
      {
        method: 'POST',
        url: 'https://50000-abc123.sandboxes.example.com/files/move',
        body: {
          source: '/workspace/a.txt',
          destination: '/workspace/b.txt',
          overwrite: true,
        },
      },
      {
        method: 'DELETE',
        url: 'https://50000-abc123.sandboxes.example.com/files?path=%2Fworkspace%2Fnested&recursive=true',
      },
    ])
  })

  test('uploads and downloads bytes with capability authentication', async () => {
    const seen: Array<{
      method: string
      url: string
      token: string | null
      contentType: string | null
      body?: number[]
    }> = []
    const client = filesClient(async (request) => {
      seen.push({
        method: request.method,
        url: request.url,
        token: request.headers.get('X-Sandbox-Token'),
        contentType: request.headers.get('Content-Type'),
        body:
          request.method === 'PUT'
            ? [...new Uint8Array(await request.arrayBuffer())]
            : undefined,
      })
      if (request.method === 'GET') {
        return new Response(Uint8Array.from([1, 2, 3]))
      }
      return new Response(null, { status: 204 })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.files.upload('/workspace/a.bin', Uint8Array.from([4, 5]), {
      mode: '0600',
    })
    const bytes = await sandbox.files.download('/workspace/a.bin')

    expect([...bytes]).toEqual([1, 2, 3])
    expect(seen).toEqual([
      {
        method: 'PUT',
        url: 'https://50000-abc123.sandboxes.example.com/files/content?path=%2Fworkspace%2Fa.bin&mode=0600',
        token: 'cap-epoch-1',
        contentType: 'application/octet-stream',
        body: [4, 5],
      },
      {
        method: 'GET',
        url: 'https://50000-abc123.sandboxes.example.com/files/content?path=%2Fworkspace%2Fa.bin',
        token: 'cap-epoch-1',
        contentType: null,
        body: undefined,
      },
    ])
  })

  test('watch authenticates and emits only validated file events', async () => {
    const seen: {
      url?: string
      protocols?: string[]
      socket?: FakeWebSocket
    } = {}
    const client = filesClient(() => jsonResponse(500), {
      webSocket: fakeWebSocketFactory(seen),
    })
    const sandbox = await client.sandboxes.create({ template: 'base' })
    const watch = sandbox.files.watch('/workspace/a b', {
      recursive: true,
      after: 2,
    })
    const socket = seen.socket
    if (socket === undefined) throw new Error('fake WebSocket was not created')

    const events: unknown[] = []
    watch.onEvent((event) => events.push(event))
    socket.receive('{"type":"future","sequence":3}')
    socket.receive(
      '{"type":"moved","sequence":3,"path":"/workspace/b","old_path":"/workspace/a","kind":"file"}',
    )

    expect(seen.url).toBe(
      'wss://50000-abc123.sandboxes.example.com/files/watch?path=%2Fworkspace%2Fa+b&recursive=true&after=2',
    )
    expect(seen.protocols).toEqual([
      'fissionplane.v1',
      'fissionplane.token.Y2FwLWVwb2NoLTE',
    ])
    expect(events).toEqual([
      {
        type: 'moved',
        sequence: 3,
        path: '/workspace/b',
        oldPath: '/workspace/a',
        kind: 'file',
      },
    ])
  })

  test('watch rejects malformed known events', async () => {
    const seen: { socket?: FakeWebSocket } = {}
    const client = filesClient(() => jsonResponse(500), {
      webSocket: fakeWebSocketFactory(seen),
    })
    const sandbox = await client.sandboxes.create({ template: 'base' })
    const watch = sandbox.files.watch('/workspace')
    const event = watch[Symbol.asyncIterator]().next()

    seen.socket?.receive(
      '{"type":"modified","sequence":3,"path":7,"kind":"file"}',
    )

    await expect(event).rejects.toThrow('malformed known modified frame')
  })
})
