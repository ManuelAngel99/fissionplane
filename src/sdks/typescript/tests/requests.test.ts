import { describe, expect, test } from 'vitest'

import {
  AuthenticationError,
  FissionPlane,
  FissionPlaneError,
  sdkVersion,
  userAgent,
  type Logger,
} from '../src/index'
import { jsonResponse, makeClient, sandboxBody, tokenBody } from './helpers'

/**
 * A fetch that never settles until its request is aborted. The Request
 * itself stays referenced by the closures below: it owns the only
 * strong reference to the controller forwarding aborts to its signal.
 */
const hangingFetch: typeof fetch = (input, init) => {
  const request = new Request(input, init)
  return new Promise((_resolve, reject) => {
    if (request.signal.aborted) {
      reject(request.signal.reason)
      return
    }
    request.signal.addEventListener(
      'abort',
      () => reject(request.signal.reason),
      { once: true },
    )
  })
}

/** Collects every message the SDK logs, tagged by level. */
function recordingLogger(lines: string[]): Logger {
  return {
    debug: (message) => lines.push(`debug: ${message}`),
    info: (message) => lines.push(`info: ${message}`),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
  }
}

describe('user agent', () => {
  test('sdkVersion matches the package manifest', async () => {
    const manifest = await import('../package.json', { with: { type: 'json' } })
    expect(sdkVersion).toBe(manifest.default.version)
    expect(userAgent).toBe(`fissionplane-typescript/${sdkVersion}`)
  })

  test('control-plane and data-plane requests carry the SDK product token', async () => {
    const agents: Array<string | null> = []
    const client = makeClient((request) => {
      agents.push(request.headers.get('User-Agent'))
      if (new URL(request.url).hostname.endsWith('.sandboxes.example.com')) {
        return jsonResponse(200, { exit_code: 0, stdout: '', stderr: '' })
      }
      return jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.commands.run('true')

    expect(agents).toEqual([userAgent, userAgent])
  })

  test('an explicit header wins over the SDK product token', async () => {
    let agent: string | null = null
    const client = makeClient((request) => {
      agent = request.headers.get('User-Agent')
      return jsonResponse(200, sandboxBody())
    })

    await client.sandboxes.get('abc123', {
      headers: { 'User-Agent': 'my-app/9.9' },
    })

    expect(agent).toBe('my-app/9.9')
  })
})

describe('timeouts', () => {
  test('a request aborts once requestTimeoutMs elapses', async () => {
    const client = new FissionPlane({
      apiKey: 'key123',
      baseUrl: 'http://control-plane.test',
      fetch: hangingFetch,
      requestTimeoutMs: 20,
      maxRetries: 0,
    })

    const request = client.sandboxes.get('abc123')
    await expect(request).rejects.toBeInstanceOf(FissionPlaneError)
    await expect(request).rejects.toMatchObject({ code: 'request_timeout' })
    await expect(request).rejects.toThrow(/timed out after 20ms/u)
  })

  test('a per-call timeout overrides the client default without leaking a header', async () => {
    const headerNames: string[][] = []
    const client = new FissionPlane({
      apiKey: 'key123',
      baseUrl: 'http://control-plane.test',
      // Disabled client-wide, so only the per-call value can abort this.
      requestTimeoutMs: 0,
      maxRetries: 0,
      fetch: (input, init) => {
        const names: string[] = []
        new Request(input, init).headers.forEach((_value, name) =>
          names.push(name),
        )
        headerNames.push(names)
        return hangingFetch(input, init)
      },
    })

    await expect(
      client.sandboxes.get('abc123', { requestTimeoutMs: 15 }),
    ).rejects.toThrow(/timed out after 15ms/u)
    expect(headerNames[0]).not.toContain('x-fissionplane-request-timeout-ms')
  })

  test('requestTimeoutMs of zero leaves the request running', async () => {
    const client = makeClient(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return jsonResponse(200, sandboxBody())
      },
      { requestTimeoutMs: 0 },
    )

    await expect(client.sandboxes.get('abc123')).resolves.toBeDefined()
  })
})

describe('cancellation', () => {
  test('an aborted signal rejects the call and stops further attempts', async () => {
    const controller = new AbortController()
    let attempts = 0
    const client = new FissionPlane({
      apiKey: 'key123',
      baseUrl: 'http://control-plane.test',
      fetch: (input, init) => {
        attempts += 1
        controller.abort(new Error('caller changed its mind'))
        return hangingFetch(input, init)
      },
    })

    await expect(
      client.sandboxes.get('abc123', { signal: controller.signal }),
    ).rejects.toThrow('caller changed its mind')
    expect(attempts).toBe(1)
  })
})

describe('retries', () => {
  test('a retryable failure is replayed up to maxRetries times', async () => {
    let attempts = 0
    const lines: string[] = []
    const client = makeClient(
      () => {
        attempts += 1
        if (attempts < 3) {
          return jsonResponse(503, {
            code: 'unavailable',
            message: 'node draining',
          })
        }
        return jsonResponse(200, sandboxBody())
      },
      { maxRetries: 2, logger: recordingLogger(lines) },
    )

    const sandbox = await client.sandboxes.get('abc123')

    expect(sandbox.sandboxId).toBe('abc123')
    expect(attempts).toBe(3)
    expect(lines.filter((line) => line.includes('retrying'))).toHaveLength(2)
    expect(lines[0]).toMatch(/GET \/v1\/sandboxes\/\{sandboxId\} failed/u)
  })

  test('maxRetries of zero disables replay', async () => {
    let attempts = 0
    const client = makeClient(
      () => {
        attempts += 1
        return jsonResponse(503, { code: 'unavailable', message: 'nope' })
      },
      { maxRetries: 0 },
    )

    await expect(client.sandboxes.get('abc123')).rejects.toBeInstanceOf(
      FissionPlaneError,
    )
    expect(attempts).toBe(1)
  })

  test('a rate limit is retried by default', async () => {
    let attempts = 0
    const client = makeClient(
      () => {
        attempts += 1
        if (attempts === 1) {
          return jsonResponse(429, {
            code: 'quota_exceeded',
            message: 'slow down',
          })
        }
        return jsonResponse(200, sandboxBody())
      },
      { maxRetries: 1 },
    )

    await client.sandboxes.get('abc123')

    expect(attempts).toBe(2)
  })

  test('an explicit retryable of false is honoured', async () => {
    let attempts = 0
    const client = makeClient(
      () => {
        attempts += 1
        return jsonResponse(503, {
          code: 'permanent',
          message: 'do not come back',
          retryable: false,
        })
      },
      { maxRetries: 2 },
    )

    await expect(client.sandboxes.get('abc123')).rejects.toThrow(
      'do not come back',
    )
    expect(attempts).toBe(1)
  })

  test('an unkeyed create is never replayed', async () => {
    let attempts = 0
    const client = makeClient(
      () => {
        attempts += 1
        return jsonResponse(503, { code: 'unavailable', message: 'busy' })
      },
      { maxRetries: 2 },
    )

    await expect(
      client.sandboxes.create({ template: 'base' }),
    ).rejects.toBeInstanceOf(FissionPlaneError)
    expect(attempts).toBe(1)
  })

  test('an idempotency key makes a create replayable', async () => {
    let attempts = 0
    const keys: Array<string | null> = []
    const client = makeClient(
      (request) => {
        attempts += 1
        keys.push(request.headers.get('Idempotency-Key'))
        if (attempts === 1) {
          return jsonResponse(503, { code: 'unavailable', message: 'busy' })
        }
        return jsonResponse(201, {
          sandbox: sandboxBody(),
          token: tokenBody(),
        })
      },
      { maxRetries: 2 },
    )

    const sandbox = await client.sandboxes.create(
      { template: 'base' },
      { idempotencyKey: 'run-42' },
    )

    expect(sandbox.sandboxId).toBe('abc123')
    expect(attempts).toBe(2)
    expect(keys).toEqual(['run-42', 'run-42'])
  })

  test('an unarmed handle fails immediately instead of being replayed', async () => {
    let dataPlaneAttempts = 0
    const client = makeClient((request) => {
      if (new URL(request.url).hostname.endsWith('.sandboxes.example.com')) {
        dataPlaneAttempts += 1
      }
      return jsonResponse(200, sandboxBody())
    })

    const sandbox = await client.sandboxes.get('abc123')
    await expect(sandbox.files.list('/workspace')).rejects.toThrow(/mintToken/u)
    expect(dataPlaneAttempts).toBe(0)
  })
})

describe('per-call overrides', () => {
  test('extra headers reach the control plane', async () => {
    let trace: string | null = null
    const client = makeClient((request) => {
      trace = request.headers.get('X-Trace-Id')
      return jsonResponse(200, sandboxBody())
    })

    await client.sandboxes.get('abc123', { headers: { 'X-Trace-Id': 't-1' } })

    expect(trace).toBe('t-1')
  })

  test('data-plane calls accept the same overrides', async () => {
    let trace: string | null = null
    const client = makeClient((request) => {
      if (new URL(request.url).hostname.endsWith('.sandboxes.example.com')) {
        trace = request.headers.get('X-Trace-Id')
        return jsonResponse(200, { exit_code: 0, stdout: '', stderr: '' })
      }
      return jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.commands.run('true', { headers: { 'X-Trace-Id': 't-2' } })

    expect(trace).toBe('t-2')
  })
})

describe('credential validation', () => {
  test('an empty API key is rejected with guidance', () => {
    expect(() => new FissionPlane({ apiKey: '' })).toThrow(AuthenticationError)
    expect(() => new FissionPlane({ apiKey: '' })).toThrow(
      /FISSIONPLANE_API_KEY/u,
    )
  })

  test('an API key carrying whitespace is rejected', () => {
    expect(() => new FissionPlane({ apiKey: 'key 123' })).toThrow(
      /contains whitespace/u,
    )
    expect(() => new FissionPlane({ apiKey: 'key123\n' })).toThrow(
      AuthenticationError,
    )
  })

  test('an empty access token is rejected', () => {
    expect(() => new FissionPlane({ accessToken: '   ' })).toThrow(
      AuthenticationError,
    )
  })

  test('a well-formed credential is accepted', () => {
    expect(() => new FissionPlane({ apiKey: 'key123' })).not.toThrow()
  })
})
