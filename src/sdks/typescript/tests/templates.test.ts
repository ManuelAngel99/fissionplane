import { describe, expect, test } from 'vitest'

import {
  FissionPlaneError,
  TemplateBuild,
  TemplateBuildError,
  type TemplateBuildInfo,
  type TemplateBuildStatus,
} from '../src/index'
import { jsonResponse, makeClient } from './helpers'

function buildBody(
  status: TemplateBuildStatus = 'queued',
  overrides: Partial<TemplateBuildInfo> = {},
): TemplateBuildInfo {
  return {
    build_id: 'bld1',
    status,
    image: 'python:3.12',
    created_at: '2026-07-28T12:00:00Z',
    ...overrides,
  }
}

function stubSleep(delays: number[]) {
  return async (ms: number) => {
    delays.push(ms)
  }
}

describe('builds', () => {
  test('build POSTs the request body through unchanged', async () => {
    const seen: Record<string, unknown> = {}
    const client = makeClient(async (request) => {
      seen.method = request.method
      seen.path = new URL(request.url).pathname
      seen.body = await request.json()
      return jsonResponse(201, buildBody('queued'))
    })

    const request = {
      image: 'python:3.12',
      alias: 'py-flask',
      steps: [{ command: 'pip install flask', env: { PIP_NO_CACHE_DIR: '1' } }],
      start_command: 'python /app/server.py',
      ready_command: 'curl -sf localhost:8000/health',
    }
    const build = await client.templates.build(request)

    expect(seen.method).toBe('POST')
    expect(seen.path).toBe('/v1/templates/builds')
    expect(seen.body).toEqual(request)
    expect(build.buildId).toBe('bld1')
    expect(build.info.status).toBe('queued')
  })

  test('getBuild fetches by identifier', async () => {
    const client = makeClient((request) => {
      expect(request.method).toBe('GET')
      expect(new URL(request.url).pathname).toBe('/v1/templates/builds/bld1')
      return jsonResponse(200, buildBody('building'))
    })

    const build = await client.templates.getBuild('bld1')
    expect(build.info.status).toBe('building')
  })

  test('delete resolves on 204', async () => {
    const client = makeClient((request) => {
      expect(request.method).toBe('DELETE')
      expect(new URL(request.url).pathname).toBe('/v1/templates/py-flask')
      return jsonResponse(204)
    })

    await expect(client.templates.delete('py-flask')).resolves.toBeUndefined()
  })
})

describe('wait', () => {
  test('polls until succeeded and returns the final info', async () => {
    let polls = 0
    const client = makeClient(() => {
      polls += 1
      if (polls === 1) return jsonResponse(200, buildBody('queued'))
      if (polls === 2) return jsonResponse(200, buildBody('building'))
      return jsonResponse(200, buildBody('succeeded', { artifact_id: 'art9' }))
    })

    const delays: number[] = []
    const build = new TemplateBuild(
      client.api,
      buildBody('queued'),
      stubSleep(delays),
    )
    const info = await build.wait({ pollIntervalMs: 5 })

    expect(info.status).toBe('succeeded')
    expect(info.artifact_id).toBe('art9')
    expect(build.info).toBe(info)
    expect(polls).toBe(3)
    expect(delays).toEqual([5, 5])
  })

  test('a failed build raises TemplateBuildError with the error string', async () => {
    const client = makeClient(() =>
      jsonResponse(
        200,
        buildBody('failed', { error: 'step 3 exited with status 1' }),
      ),
    )

    const build = new TemplateBuild(
      client.api,
      buildBody('queued'),
      stubSleep([]),
    )
    const request = build.wait()
    await expect(request).rejects.toBeInstanceOf(TemplateBuildError)
    await expect(request).rejects.toMatchObject({
      buildError: 'step 3 exited with status 1',
      message: expect.stringContaining('step 3 exited with status 1'),
    })
  })

  test('timeoutMs elapsing raises FissionPlaneError, not TemplateBuildError', async () => {
    const client = makeClient(() => jsonResponse(200, buildBody('building')))

    const build = new TemplateBuild(
      client.api,
      buildBody('queued'),
      stubSleep([]),
    )
    const request = build.wait({ pollIntervalMs: 1, timeoutMs: 0 })
    await expect(request).rejects.toBeInstanceOf(FissionPlaneError)
    await expect(request).rejects.not.toBeInstanceOf(TemplateBuildError)
    await expect(request).rejects.toThrow(/bld1.*building/)
  })
})

describe('logs', () => {
  test('passes the offset and returns entries with nextOffset', async () => {
    const client = makeClient((request) => {
      const url = new URL(request.url)
      expect(url.pathname).toBe('/v1/templates/builds/bld1/logs')
      expect(url.searchParams.get('offset')).toBe('3')
      return jsonResponse(200, {
        entries: [{ timestamp: '2026-07-28T12:02:00Z', message: 'step 4 ok' }],
        next_offset: 4,
      })
    })

    const build = new TemplateBuild(client.api, buildBody('building'))
    const page = await build.logs(3)

    expect(page.entries).toEqual([
      { timestamp: '2026-07-28T12:02:00Z', message: 'step 4 ok' },
    ])
    expect(page.nextOffset).toBe(4)
  })
})
