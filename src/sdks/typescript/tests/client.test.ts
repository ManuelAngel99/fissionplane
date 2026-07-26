import { describe, expect, test } from 'vitest'

import { ConflictError, NotFoundError, RateLimitError } from '../src/index'
import { jsonResponse, makeClient, sandboxBody, tokenBody } from './helpers'

describe('create', () => {
  test('returns a handle with token and sends credentials', async () => {
    const seen: Record<string, unknown> = {}
    const client = makeClient(async (request) => {
      const url = new URL(request.url)
      seen.method = request.method
      seen.path = url.pathname
      seen.apiKey = request.headers.get('X-API-Key')
      seen.idempotency = request.headers.get('Idempotency-Key')
      seen.body = await request.json()
      return jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() })
    })

    const sandbox = await client.sandboxes.create(
      { template: 'base', name: 'job42', metadata: { run: '42' } },
      { idempotencyKey: 'idem-1' },
    )

    expect(seen.method).toBe('POST')
    expect(seen.path).toBe('/v1/sandboxes')
    expect(seen.apiKey).toBe('key123')
    expect(seen.idempotency).toBe('idem-1')
    expect(seen.body).toEqual({
      template: 'base',
      name: 'job42',
      metadata: { run: '42' },
    })
    expect(sandbox.sandboxId).toBe('abc123')
    expect(sandbox.token?.token).toBe('cap-epoch-1')
    expect(sandbox.hostname(3000)).toBe('3000-abc123.sandboxes.example.com')
  })

  test('name collision maps to ConflictError', async () => {
    const client = makeClient(() =>
      jsonResponse(409, { code: 'name_taken', message: 'name job42 exists' }),
    )
    const request = client.sandboxes.create({
      template: 'base',
      name: 'job42',
    })
    await expect(request).rejects.toBeInstanceOf(ConflictError)
    await expect(request).rejects.toMatchObject({
      code: 'name_taken',
      status: 409,
      retryable: false,
    })
  })

  test('quota maps to RateLimitError with retryable', async () => {
    const client = makeClient(() =>
      jsonResponse(429, {
        code: 'quota_exceeded',
        message: 'concurrency limit',
        retryable: true,
        request_id: 'req-9',
      }),
    )
    const request = client.sandboxes.create({ template: 'base' })
    await expect(request).rejects.toBeInstanceOf(RateLimitError)
    await expect(request).rejects.toMatchObject({
      code: 'quota_exceeded',
      retryable: true,
      requestId: 'req-9',
    })
  })

  test('malformed error fields are ignored', async () => {
    const client = makeClient(() =>
      jsonResponse(500, {
        code: 42,
        message: ['invalid'],
        retryable: 'no',
        request_id: false,
      }),
    )

    await expect(
      client.sandboxes.create({ template: 'base' }),
    ).rejects.toMatchObject({
      message: 'request failed with status 500',
      status: 500,
      code: undefined,
      retryable: true,
      requestId: undefined,
    })
  })
})

describe('lifecycle', () => {
  test('resume re-arms the token for the new epoch', async () => {
    const client = makeClient((request) => {
      const path = new URL(request.url).pathname
      if (path === '/v1/sandboxes/abc123') {
        return jsonResponse(200, sandboxBody('abc123', 1))
      }
      expect(path).toBe('/v1/sandboxes/abc123/resume')
      return jsonResponse(200, {
        sandbox: sandboxBody('abc123', 2),
        token: tokenBody(2),
      })
    })

    const sandbox = await client.sandboxes.get('abc123')
    expect(sandbox.token).toBeUndefined()
    await sandbox.resume({ deadlineSeconds: 600 })
    expect(sandbox.info.epoch).toBe(2)
    expect(sandbox.token?.epoch).toBe(2)
  })

  test('unknown sandbox maps to NotFoundError', async () => {
    const client = makeClient(() =>
      jsonResponse(404, { code: 'not_found', message: 'nope' }),
    )
    await expect(client.sandboxes.get('zzz999')).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  test('delete resolves on 204', async () => {
    const client = makeClient((request) => {
      if (request.method === 'DELETE') return jsonResponse(204)
      return jsonResponse(200, sandboxBody())
    })
    const sandbox = await client.sandboxes.get('abc123')
    await expect(sandbox.delete()).resolves.toBeUndefined()
  })
})

describe('list', () => {
  test('iterate follows cursors and encodes filters', async () => {
    const pages: Array<Record<string, string>> = []
    const client = makeClient((request) => {
      const url = new URL(request.url)
      const params = Object.fromEntries(url.searchParams)
      pages.push(params)
      if (params.cursor === undefined) {
        return jsonResponse(200, {
          items: [sandboxBody('aaa111')],
          next_cursor: 'page2',
        })
      }
      return jsonResponse(200, {
        items: [sandboxBody('bbb222')],
        next_cursor: null,
      })
    })

    const ids: string[] = []
    for await (const sandbox of client.sandboxes.iterate({
      state: 'running',
      metadata: { run: '42', user: 'alice' },
    })) {
      ids.push(sandbox.sandboxId)
    }

    expect(ids).toEqual(['aaa111', 'bbb222'])
    expect(pages[0]?.state).toBe('running')
    expect(pages[0]?.metadata).toBe('run=42&user=alice')
    expect(pages[1]?.cursor).toBe('page2')
  })

  test('iterate walks a three-page collection and logs each page', async () => {
    const cursors = ['page2', 'page3', null]
    let page = 0
    const lines: string[] = []
    const client = makeClient(
      () => {
        const nextCursor = cursors[page] ?? null
        page += 1
        return jsonResponse(200, {
          items: [sandboxBody(`sbx-${page}a`), sandboxBody(`sbx-${page}b`)],
          next_cursor: nextCursor,
        })
      },
      { logger: { debug: (message) => lines.push(message) } },
    )

    const ids: string[] = []
    for await (const sandbox of client.sandboxes.iterate({ limit: 2 })) {
      ids.push(sandbox.sandboxId)
    }

    expect(ids).toEqual([
      'sbx-1a',
      'sbx-1b',
      'sbx-2a',
      'sbx-2b',
      'sbx-3a',
      'sbx-3b',
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/page 1 \(2 sandboxes, more follow\)/u)
    expect(lines[2]).toMatch(/page 3 \(2 sandboxes, last page\)/u)
  })
})
