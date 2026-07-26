import { describe, expect, test } from 'vitest'

import { jsonResponse, makeClient, sandboxBody, type Handler } from './helpers'

function portsClient(onPorts: Handler) {
  return makeClient(async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/v1/sandboxes/abc123' && request.method === 'GET') {
      return jsonResponse(200, sandboxBody())
    }
    return onPorts(request)
  })
}

describe('ports', () => {
  test('expose sends PUT with visibility body and maps the record', async () => {
    const seen: Record<string, unknown> = {}
    const client = portsClient(async (request) => {
      const url = new URL(request.url)
      seen.method = request.method
      seen.path = url.pathname
      seen.body = await request.json()
      return jsonResponse(200, {
        port: 3000,
        visibility: 'public',
        url: 'https://3000-abc123.sandboxes.example.com',
      })
    })

    const sandbox = await client.sandboxes.get('abc123')
    const exposure = await sandbox.ports.expose(3000, 'public')

    expect(seen.method).toBe('PUT')
    expect(seen.path).toBe('/v1/sandboxes/abc123/ports/3000')
    expect(seen.body).toEqual({ visibility: 'public' })
    expect(exposure.port).toBe(3000)
    expect(exposure.visibility).toBe('public')
    expect(exposure.url).toBe('https://3000-abc123.sandboxes.example.com')
  })

  test('unexpose resolves on 204', async () => {
    const seen: Record<string, unknown> = {}
    const client = portsClient((request) => {
      seen.method = request.method
      seen.path = new URL(request.url).pathname
      return jsonResponse(204)
    })

    const sandbox = await client.sandboxes.get('abc123')
    await expect(sandbox.ports.unexpose(8080)).resolves.toBeUndefined()

    expect(seen.method).toBe('DELETE')
    expect(seen.path).toBe('/v1/sandboxes/abc123/ports/8080')
  })

  test('list unwraps items', async () => {
    const client = portsClient((request) => {
      expect(request.method).toBe('GET')
      expect(new URL(request.url).pathname).toBe('/v1/sandboxes/abc123/ports')
      return jsonResponse(200, {
        items: [
          {
            port: 3000,
            visibility: 'public',
            url: 'https://3000-abc123.sandboxes.example.com',
          },
          {
            port: 5432,
            visibility: 'private',
            url: 'https://5432-abc123.sandboxes.example.com',
          },
        ],
      })
    })

    const sandbox = await client.sandboxes.get('abc123')
    const records = await sandbox.ports.list()

    expect(records.map((r) => r.port)).toEqual([3000, 5432])
    expect(records[0]?.visibility).toBe('public')
  })
})
