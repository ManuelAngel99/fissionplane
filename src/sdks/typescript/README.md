# FissionPlane TypeScript SDK

Use FissionPlane to create and control isolated sandboxes on your own
infrastructure. `@fissionplane/sdk` connects TypeScript applications to an
FissionPlane installation.

The SDK can:

- create, list, pause, resume, and delete sandboxes;
- run commands, stream process output, and use PTYs;
- read, write, and watch sandbox files;
- make a sandbox port private or public; and
- build templates from OCI images.

FissionPlane requires an existing on-premises installation. See the
[FissionPlane repository](https://github.com/ManuelAngel99/fissionplane) for the
platform source and deployment information.

## Requirements

- Node.js 20 or later
- An FissionPlane control plane URL
- An API key or OIDC bearer token
- A template alias or template artifact ID

## Install

Install the package with your package manager:

```bash
npm install @fissionplane/sdk
```

```bash
pnpm add @fissionplane/sdk
```

## Configure the client

Set the control plane URL and API key:

```bash
export FISSIONPLANE_API_URL="https://api.sandbox.example.com"
export FISSIONPLANE_API_KEY="your-api-key"
```

The client reads both variables in Node.js:

```ts
import { FissionPlane } from '@fissionplane/sdk'

const client = new FissionPlane()
```

You can also pass the values directly:

```ts
const client = new FissionPlane({
  baseUrl: 'https://api.sandbox.example.com',
  apiKey: 'your-api-key',
})
```

Use `accessToken` instead of `apiKey` for an OIDC bearer token. An API key
takes precedence when you set both values. The constructor rejects an empty
credential or one containing whitespace.

### Timeouts, retries, and logging

The client options also set the request behaviour shared by every call:

```ts
const client = new FissionPlane({
  requestTimeoutMs: 30_000,
  maxRetries: 3,
  logger: console,
})
```

- `requestTimeoutMs` aborts a request after the given number of milliseconds.
  It defaults to `60000`. Set `0` to disable timeouts.
- `maxRetries` sets how many extra attempts a failed request gets. It defaults
  to `2`. Set `0` to disable retries. The SDK waits between attempts using
  exponential backoff with full jitter, starting at 250 ms.
- `logger` receives debug messages about retries, capability token re-mints,
  and pagination. Every method of the `Logger` type is optional, so `console`
  works as-is. The default logger discards everything.

The SDK retries a request when the platform marks the failure as retryable,
which covers rate limits, server faults, and timeouts. It never replays a
request whose outcome you cannot deduplicate: `sandboxes.create()` is retried
only when you pass an `idempotencyKey`.

Every request carries `User-Agent: fissionplane-typescript/<version>`, exported
as `userAgent`.

### Per-call overrides

Every method that takes options accepts `requestTimeoutMs`, `signal`, and
`headers` alongside its own settings:

```ts
const controller = new AbortController()

const sandbox = await client.sandboxes.get('sbx-1', {
  requestTimeoutMs: 5_000,
  signal: controller.signal,
  headers: { 'X-Trace-Id': trace },
})
```

A per-call `requestTimeoutMs` replaces the client default for that call, and a
call aborts as soon as either the signal or the timeout fires. Your own headers
win over the SDK's. On `commands.attach()` and `files.watch()`,
`requestTimeoutMs` bounds the WebSocket handshake rather than the lifetime of
the stream, and `signal` closes the stream.

## Create a sandbox and run a command

Sandbox creation returns after a node acknowledges the sandbox.

```ts
import { FissionPlane } from '@fissionplane/sdk'

const client = new FissionPlane()
const sandbox = await client.sandboxes.create(
  {
    template: 'base',
    name: 'example-job',
    deadline_seconds: 600,
  },
  { idempotencyKey: 'example-job-1' },
)

try {
  const result = await sandbox.commands.run('node', {
    args: ['--eval', "console.log('hello from FissionPlane')"],
    timeoutSeconds: 30,
  })
  console.log(result.stdout)
  console.log(result.exit_code)
} finally {
  await sandbox.delete()
}
```

`commands.run()` waits for the command to exit. It returns the exit code,
standard output, standard error, and an optional truncation flag.

Use `sandbox.commands.listProcesses()` to list supervised processes. Use
`sandbox.commands.kill(pid, 'SIGTERM')` to signal one process.

Start a background process when output must be followed or stdin stays open:

```ts
const child = await sandbox.commands.start('bash', {
  pty: { cols: 120, rows: 40 },
})
const attachment = child.attach()
attachment.sendInput('pwd\n')

for await (const event of attachment) {
  if (event.type === 'stdout') console.log(event.data)
  if (event.type === 'exit') break
}
```

Filesystem operations use the sandbox data plane directly:

```ts
await sandbox.files.makeDir('/workspace')
await sandbox.files.write(
  '/workspace/input.txt',
  new TextEncoder().encode('hello'),
)
const entries = await sandbox.files.list('/workspace')
const watch = sandbox.files.watch('/workspace', { recursive: true })
```

## Manage the sandbox lifecycle

A sandbox has one of four visible states: `running`, `paused`, `terminated`,
or `failed`.

```ts
await sandbox.pause()
await sandbox.resume({ deadlineSeconds: 600 })
await sandbox.extendDeadline(900)
await sandbox.delete()
```

`pause()` saves a snapshot and releases node capacity. `resume()` restores the
snapshot on a node. A resumed sandbox has a new epoch.

Capability tokens belong to one sandbox epoch. The SDK replaces the token on
the handle after `resume()`. A handle returned by `sandboxes.get()` or
`sandboxes.iterate()` has no token. Call `sandbox.mintToken()` before you use
commands on such a handle.

A token also expires. When the sandbox agent rejects one, `sandbox.commands`
and `sandbox.files` mint a fresh token and replay the request once. Streams
opened by `commands.attach()` and `files.watch()` are the exception: a rejected
WebSocket handshake reaches the SDK as an opaque socket failure, so those
require a valid token up front.

Use an idempotency key when your application can retry sandbox creation. The
same key returns the sandbox from the first successful request.

## Expose a port

Every port is private by default. Private access requires a capability token.
Make one port public only when anonymous access is required.

```ts
const exposure = await sandbox.ports.expose(3000, 'public')
console.log(exposure.url)

const records = await sandbox.ports.list()
await sandbox.ports.unexpose(3000)
```

`unexpose()` removes the exposure record. The port then returns to private
access.

## Build and use a template

Template builds run asynchronously on the FissionPlane installation.

```ts
const build = await client.templates.build({
  image: 'node:22',
  alias: 'node-tools',
  steps: [{ command: 'npm install --global pnpm' }],
})

const template = await build.wait({ timeoutMs: 10 * 60 * 1000 })
const sandbox = await client.sandboxes.create({ template: 'node-tools' })
```

Use `build.logs(offset)` to read build output. Pass `nextOffset` to the next
call. Use `client.templates.getBuild(buildId)` to reconnect to an existing
build.

## List sandboxes

Read one page with `list()`:

```ts
const page = await client.sandboxes.list({
  state: 'running',
  metadata: { team: 'tools' },
  limit: 20,
})
```

Use `iterate()` to read all matching pages. It follows each page's
`nextCursor` until the collection is exhausted:

```ts
for await (const sandbox of client.sandboxes.iterate({ state: 'running' })) {
  console.log(sandbox.sandboxId)
}
```

`iterate()` takes the same filters as `list()` minus `cursor`. Break out of the
loop to stop; the SDK fetches a page only when the previous one runs out.

## Handle errors

All SDK errors inherit from `FissionPlaneError`. HTTP errors include `status`,
`code`, `retryable`, and `requestId` when the server returns those fields.

```ts
import { FissionPlaneError, RateLimitError } from '@fissionplane/sdk'

try {
  await client.sandboxes.create({ template: 'base' })
} catch (error: unknown) {
  if (error instanceof RateLimitError && error.retryable) {
    console.error(`retry later; request ID: ${error.requestId}`)
  } else if (error instanceof FissionPlaneError) {
    console.error(error.code, error.message)
  } else {
    throw error
  }
}
```

The package also exports errors for authentication, authorization, missing
resources, lifecycle conflicts, expired snapshots, command timeouts, and
failed template builds.

## Control plane and data plane

The control plane manages sandboxes, ports, tokens, and templates. The
sandbox data plane runs commands, streams process I/O, and accesses files.

The SDK sends your API key or OIDC token to the control plane. It sends a
short-lived capability token to the sandbox data plane. The SDK stores that
token on the sandbox handle.

The data-plane agent uses port `50000` by default. Set `agentPort` only when
your installation uses a different port. You can also provide a custom
`fetch` implementation in the client options.

`client.api` exposes the generated, fully typed HTTP client for operations this
SDK does not wrap. Those calls carry the credentials, the SDK `User-Agent`, and
the request timeout, but not the retry loop.

## Build the package locally

```bash
pnpm build      # type-checks, then bundles ESM, CommonJS, and declarations
pnpm run docs   # writes the HTML API reference to docs/
```

`pnpm run docs` needs the `run` keyword because `pnpm docs` resolves to npm's
own command.

## API status

This package is version `0.0.1` and is currently marked as private. Treat its
public API as unstable until the project publishes a stable package.

The control-plane and data-plane OpenAPI files define the HTTP contracts:

- [Control-plane specification](https://github.com/ManuelAngel99/fissionplane/blob/main/src/contracts/openapi.yaml)
- [Data-plane specification](https://github.com/ManuelAngel99/fissionplane/blob/main/src/contracts/dataplane.yaml)

## License

FissionPlane uses the
[Apache License 2.0](https://github.com/ManuelAngel99/fissionplane/blob/main/LICENSE).
