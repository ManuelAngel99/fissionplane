import { describe, expect, test } from 'vitest'

import {
  CommandTimeoutError,
  FissionPlaneError,
  type FissionPlaneOptions,
} from '../src/index'
import {
  FakeWebSocket,
  fakeWebSocketFactory,
  jsonResponse,
  makeClient,
  sandboxBody,
  tokenBody,
  type Handler,
} from './helpers'

function isDataPlane(url: URL): boolean {
  return url.hostname.endsWith('.sandboxes.example.com')
}

function commandsClient(
  onDataPlane: Handler,
  options: Partial<FissionPlaneOptions> = {},
) {
  return makeClient(async (request) => {
    const url = new URL(request.url)
    if (!isDataPlane(url)) {
      expect(url.pathname).toBe('/v1/sandboxes')
      return jsonResponse(201, { sandbox: sandboxBody(), token: tokenBody() })
    }
    return onDataPlane(request)
  }, options)
}

describe('run', () => {
  test('POSTs to the agent hostname with token header and JSON body', async () => {
    const seen: Record<string, unknown> = {}
    const client = commandsClient(async (request) => {
      seen.method = request.method
      seen.url = request.url
      seen.token = request.headers.get('X-Sandbox-Token')
      seen.body = await request.json()
      return jsonResponse(200, {
        exit_code: 0,
        stdout: 'hello\n',
        stderr: '',
        truncated: false,
      })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const result = await sandbox.commands.run('echo', {
      args: ['hello'],
      cwd: '/workspace',
      env: { GREETING: 'hi' },
      stdin: 'ignored input',
      timeoutSeconds: 30,
    })

    expect(seen.method).toBe('POST')
    expect(seen.url).toBe('https://50000-abc123.sandboxes.example.com/commands')
    expect(seen.token).toBe('cap-epoch-1')
    expect(seen.body).toEqual({
      command: 'echo',
      args: ['hello'],
      cwd: '/workspace',
      env: { GREETING: 'hi' },
      stdin: 'ignored input',
      timeout_seconds: 30,
    })
    expect(result).toEqual({
      exit_code: 0,
      stdout: 'hello\n',
      stderr: '',
      truncated: false,
    })
  })

  test('agentPort option changes the hostname', async () => {
    const seen: Record<string, unknown> = {}
    const client = commandsClient(
      (request) => {
        seen.url = request.url
        return jsonResponse(200, { exit_code: 0, stdout: '', stderr: '' })
      },
      { agentPort: 49999 },
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.commands.run('true')

    expect(seen.url).toBe('https://49999-abc123.sandboxes.example.com/commands')
  })

  test('408 maps to CommandTimeoutError', async () => {
    const client = commandsClient(() =>
      jsonResponse(408, {
        code: 'command_timeout',
        message: 'command did not exit within 5s',
      }),
    )

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const request = sandbox.commands.run('sleep', {
      args: ['999'],
      timeoutSeconds: 5,
    })
    await expect(request).rejects.toBeInstanceOf(CommandTimeoutError)
    await expect(request).rejects.toMatchObject({
      status: 408,
      code: 'command_timeout',
    })
  })

  test('a handle without a token refuses with a helpful message', async () => {
    const client = makeClient(() => jsonResponse(200, sandboxBody()))

    const sandbox = await client.sandboxes.get('abc123')
    const request = sandbox.commands.run('ls')
    await expect(request).rejects.toBeInstanceOf(FissionPlaneError)
    await expect(request).rejects.toThrow(/abc123.*mintToken/)
  })

  test('after resume, requests carry the new epoch token', async () => {
    const tokensSeen: Array<string | null> = []
    const client = makeClient((request) => {
      const url = new URL(request.url)
      if (isDataPlane(url)) {
        tokensSeen.push(request.headers.get('X-Sandbox-Token'))
        return jsonResponse(200, { exit_code: 0, stdout: '', stderr: '' })
      }
      if (url.pathname === '/v1/sandboxes') {
        return jsonResponse(201, {
          sandbox: sandboxBody('abc123', 1),
          token: tokenBody(1),
        })
      }
      expect(url.pathname).toBe('/v1/sandboxes/abc123/resume')
      return jsonResponse(200, {
        sandbox: sandboxBody('abc123', 2),
        token: tokenBody(2),
      })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.commands.run('ls')
    await sandbox.resume()
    await sandbox.commands.run('ls')

    expect(tokensSeen).toEqual(['cap-epoch-1', 'cap-epoch-2'])
  })
})

describe('processes', () => {
  test('starts a PTY process and returns an ergonomic handle', async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = []
    const client = commandsClient(async (request) => {
      requests.push({
        method: request.method,
        url: request.url,
        body: request.method === 'POST' ? await request.json() : undefined,
      })
      return jsonResponse(201, {
        pid: 42,
        command: 'bash',
        started_at: '2026-07-28T12:01:00Z',
        running: true,
        pty: true,
      })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const process = await sandbox.commands.start('bash', {
      cwd: '/workspace',
      pty: { cols: 100, rows: 30 },
    })

    expect(process.pid).toBe(42)
    expect(requests).toEqual([
      {
        method: 'POST',
        url: 'https://50000-abc123.sandboxes.example.com/processes',
        body: {
          command: 'bash',
          cwd: '/workspace',
          pty: { cols: 100, rows: 30 },
        },
      },
    ])
  })

  test('gets a process and reads logs after a sequence', async () => {
    const urls: string[] = []
    const client = commandsClient((request) => {
      urls.push(request.url)
      if (new URL(request.url).pathname.endsWith('/logs')) {
        return jsonResponse(200, {
          chunks: [{ stream: 'stdout', sequence: 8, data: 'ready\n' }],
          next_sequence: 8,
          running: true,
        })
      }
      return jsonResponse(200, {
        pid: 42,
        command: 'server',
        started_at: '2026-07-28T12:01:00Z',
        running: true,
        pty: false,
      })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const process = await sandbox.commands.get(42)
    const logs = await process.logs(7)

    expect(logs.chunks[0]?.data).toBe('ready\n')
    expect(urls).toEqual([
      'https://50000-abc123.sandboxes.example.com/processes/42',
      'https://50000-abc123.sandboxes.example.com/processes/42/logs?after=7',
    ])
  })

  test('attach authenticates, validates events, and sends PTY controls', async () => {
    const seen: {
      url?: string
      protocols?: string[]
      socket?: FakeWebSocket
    } = {}
    const client = commandsClient(() => jsonResponse(500), {
      webSocket: fakeWebSocketFactory(seen),
    })
    const sandbox = await client.sandboxes.create({ template: 'base' })
    const attachment = sandbox.commands.attach(42, { after: 7 })
    const socket = seen.socket
    if (socket === undefined) throw new Error('fake WebSocket was not created')

    attachment.sendInput('hello')
    attachment.resize(120, 40)
    attachment.signal('SIGINT')
    attachment.closeStdin()
    expect(socket.sent).toEqual([])
    socket.open()

    expect(seen.url).toBe(
      'wss://50000-abc123.sandboxes.example.com/processes/42/stream?after=7',
    )
    expect(seen.protocols).toEqual([
      'fissionplane.v1',
      'fissionplane.token.Y2FwLWVwb2NoLTE',
    ])
    expect(socket.sent.map((frame) => JSON.parse(frame))).toEqual([
      { type: 'input', data: 'hello' },
      { type: 'resize', cols: 120, rows: 40 },
      { type: 'signal', signal: 'SIGINT' },
      { type: 'close_stdin' },
    ])

    const event = attachment[Symbol.asyncIterator]().next()
    socket.receive('{"type":"future","value":1}')
    socket.receive('{"type":"stdout","sequence":8,"data":"ready\\n"}')
    await expect(event).resolves.toEqual({
      done: false,
      value: { type: 'stdout', sequence: 8, data: 'ready\n' },
    })
  })

  test('attach rejects malformed known frames', async () => {
    const seen: { socket?: FakeWebSocket } = {}
    const client = commandsClient(() => jsonResponse(500), {
      webSocket: fakeWebSocketFactory(seen),
    })
    const sandbox = await client.sandboxes.create({ template: 'base' })
    const attachment = sandbox.commands.attach(42)
    const event = attachment[Symbol.asyncIterator]().next()

    seen.socket?.receive('{"type":"stdout","sequence":"bad","data":"no"}')

    await expect(event).rejects.toThrow('malformed known stdout frame')
  })

  test('attach requires the streaming subprotocol', async () => {
    const socket = new FakeWebSocket('')
    const client = commandsClient(() => jsonResponse(500), {
      webSocket: () => socket,
    })
    const sandbox = await client.sandboxes.create({ template: 'base' })
    const attachment = sandbox.commands.attach(42)
    const event = attachment[Symbol.asyncIterator]().next()

    socket.open()

    await expect(event).rejects.toThrow('server did not select fissionplane.v1')
  })

  test('listProcesses unwraps items', async () => {
    const client = commandsClient((request) => {
      expect(request.method).toBe('GET')
      expect(request.url).toBe(
        'https://50000-abc123.sandboxes.example.com/processes',
      )
      return jsonResponse(200, {
        items: [
          {
            pid: 42,
            command: 'python server.py',
            started_at: '2026-07-28T12:01:00Z',
          },
        ],
      })
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    const processes = await sandbox.commands.listProcesses()

    expect(processes).toHaveLength(1)
    expect(processes[0]?.pid).toBe(42)
  })

  test('kill sends the signal query param', async () => {
    const urls: string[] = []
    const client = commandsClient((request) => {
      expect(request.method).toBe('DELETE')
      urls.push(request.url)
      return jsonResponse(204)
    })

    const sandbox = await client.sandboxes.create({ template: 'base' })
    await sandbox.commands.kill(42, 'SIGKILL')
    await sandbox.commands.kill(43)

    expect(urls).toEqual([
      'https://50000-abc123.sandboxes.example.com/processes/42?signal=SIGKILL',
      'https://50000-abc123.sandboxes.example.com/processes/43',
    ])
  })
})
