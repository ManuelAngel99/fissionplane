# FissionPlane Python SDK

Use FissionPlane to create and control isolated sandboxes on your own
infrastructure. This package connects Python applications to an FissionPlane
installation.

The SDK can:

- create, list, pause, resume, and delete sandboxes;
- run commands, stream process output, and use PTYs;
- read, write, and watch sandbox files;
- make a sandbox port private or public;
- build templates from OCI images; and
- use synchronous or asynchronous Python.

FissionPlane requires an existing on-premises installation. See the
[FissionPlane repository](https://github.com/ManuelAngel99/fissionplane) for the
platform source and deployment information.

## Requirements

- Python 3.10 or later
- An FissionPlane control plane URL
- An API key or OIDC bearer token
- A template alias or template artifact ID

## Install

Install the package with `pip`:

```bash
pip install fissionplane
```

You can also use `uv`:

```bash
uv add fissionplane
```

## Configure the client

Set the control plane URL and API key:

```bash
export FISSIONPLANE_API_URL="https://api.sandbox.example.com"
export FISSIONPLANE_API_KEY="your-api-key"
```

`FissionPlane()` reads both variables. You can also pass the values directly:

```python
from fissionplane import FissionPlane

client = FissionPlane(
    base_url="https://api.sandbox.example.com",
    api_key="your-api-key",
)
```

Use `access_token` instead of `api_key` for an OIDC bearer token. An explicit
API key takes precedence over an access token. The client rejects an empty
credential, or one containing whitespace, when you construct it.

### Timeouts, retries, and logging

The client applies a 60 second timeout to every request. Change the default
with `request_timeout`. Pass `0` or `None` to disable the timeout.

```python
client = FissionPlane(request_timeout=30)
```

Every operation also accepts `request_timeout` for one call:

```python
sandbox = client.sandboxes.get("sbx-123", request_timeout=5)
result = sandbox.commands.run("make", args=["build"], request_timeout=0)
```

The client retries a failed request twice by default, with exponential
backoff and jitter. Set `max_retries=0` to disable retries. The SDK only
retries a request that is safe to send again:

- reads, such as `get()`, `list()`, and `files.read()`;
- `sandboxes.create()` when you pass an `idempotency_key`; and
- responses the server marks `retryable`, or status 429 and 5xx responses
  that the server does not mark `retryable: false`.

```python
client = FissionPlane(max_retries=4)
sandbox = client.sandboxes.create("base", idempotency_key="example-job-1")
```

Pass `headers` to add or replace headers on one call:

```python
client.sandboxes.list(headers={"X-Request-Source": "nightly-job"})
```

The SDK reports retries, capability token re-mints, and page fetches at debug
level on the `fissionplane` logger. Pass your own logger to redirect them:

```python
import logging

logging.basicConfig(level=logging.DEBUG)
client = FissionPlane(logger=logging.getLogger("my-app.sandboxes"))
```

Anything you pass in `httpx_args` wins over the SDK defaults, including
`timeout` and `headers`.

## Create a sandbox and run a command

Sandbox creation is synchronous. The call returns after a node acknowledges
the sandbox.

```python
from fissionplane import FissionPlane

client = FissionPlane()
sandbox = client.sandboxes.create(
    "base",
    name="example-job",
    deadline_seconds=600,
    idempotency_key="example-job-1",
)

try:
    result = sandbox.commands.run(
        "python",
        args=["-c", "print('hello from FissionPlane')"],
        timeout_seconds=30,
    )
    print(result.stdout)
    print(result.exit_code)
finally:
    sandbox.delete()
```

`commands.run()` waits for the command to exit. It returns the exit code,
standard output, standard error, and an optional truncation flag.

Use `sandbox.commands.list_processes()` to list supervised processes. Use
`sandbox.commands.kill(pid, "SIGTERM")` to signal one process.

Start a background process when output must be followed or stdin stays open:

```python
from fissionplane import PtySize

process = sandbox.commands.start("bash", pty=PtySize(cols=120, rows=40))
attachment = process.attach()
attachment.send_input("pwd\n")

for event in attachment:
    if event.type == "stdout":
        print(event.data, end="")
    elif event.type == "exit":
        break
```

Filesystem operations use the sandbox data plane directly:

```python
sandbox.files.make_dir("/workspace")
sandbox.files.write("/workspace/input.txt", b"hello")
entries = sandbox.files.list("/workspace")
watch = sandbox.files.watch("/workspace", recursive=True)
```

## Manage the sandbox lifecycle

A sandbox has one of four visible states: `running`, `paused`, `terminated`,
or `failed`.

```python
sandbox.pause()
sandbox.resume(deadline_seconds=600)
sandbox.extend_deadline(900)
sandbox.delete()
```

`pause()` saves a snapshot and releases node capacity. `resume()` restores the
snapshot on a node. A resumed sandbox has a new epoch.

Capability tokens belong to one sandbox epoch. The SDK replaces the token on
the handle after `resume()`. A handle returned by `sandboxes.get()` or
`sandboxes.iterate()` has no token. Call `sandbox.mint_token()` before you use
commands on such a handle.

A capability token also expires on its own schedule. When the sandbox data
plane rejects one, the handle mints a replacement and sends the request again.
This applies to command, file, and streaming calls alike, so long-lived
handles keep working without your code refreshing anything.

Use an idempotency key when your application can retry sandbox creation. The
same key returns the sandbox from the first successful request.

## Expose a port

Every port is private by default. Private access requires a capability token.
Make one port public only when anonymous access is required.

```python
exposure = sandbox.ports.expose(3000, "public")
print(exposure.url)

records = sandbox.ports.list()
sandbox.ports.unexpose(3000)
```

`unexpose()` removes the exposure record. The port then returns to private
access.

## Build and use a template

Template builds run asynchronously on the FissionPlane installation.

```python
from fissionplane import BuildStep

build = client.templates.build(
    "python:3.12",
    alias="python-tools",
    steps=[BuildStep(command="pip install httpx")],
)
template = build.wait(timeout=600)

sandbox = client.sandboxes.create("python-tools")
```

Use `build.logs(offset)` to read build output. Pass the returned offset to the
next call. Use `client.templates.get_build(build_id)` to reconnect to an
existing build.

## Use the asynchronous client

`AsyncFissionPlane` has the same operations as the synchronous client. Await
each network operation.

```python
import asyncio

from fissionplane import AsyncFissionPlane


async def main() -> None:
    client = AsyncFissionPlane()
    sandbox = await client.sandboxes.create("base")
    try:
        result = await sandbox.commands.run("python", args=["-V"])
        print(result.stdout)
    finally:
        await sandbox.delete()


asyncio.run(main())
```

Use `async for` with `client.sandboxes.iterate()` to read all matching pages.

## Read every page

`sandboxes.list()` returns one page and its `next_cursor`. Use `iterate()`
when you want every match instead. It fetches one page at a time and follows
the cursor until the collection ends.

```python
for sandbox in client.sandboxes.iterate(state=SandboxState.RUNNING, limit=50):
    print(sandbox.sandbox_id)
```

The asynchronous client returns an async generator:

```python
async for sandbox in client.sandboxes.iterate(metadata={"run": "42"}):
    print(sandbox.sandbox_id)
```

## Handle errors

All SDK errors inherit from `FissionPlaneError`. HTTP errors include `status`,
`code`, `retryable`, and `request_id` when the server returns those fields.

```python
from fissionplane import FissionPlaneError, RateLimitError

try:
    sandbox = client.sandboxes.create("base")
except RateLimitError as error:
    if error.retryable:
        print(f"retry later; request ID: {error.request_id}")
except FissionPlaneError as error:
    print(error.code, error)
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

The data-plane agent uses port `50000` by default. Pass `agent_port` to the
client only when your installation uses a different port.

## Build the API reference

The package documents its public surface with `pdoc`. Run it from
`src/sdks/python`:

```bash
uv run pdoc fissionplane -o docs
```

The command writes browsable HTML to `docs/`, which is not committed. Add
module names to document them on their own pages, for example
`uv run pdoc fissionplane fissionplane.sandboxes -o docs`. Do not point `pdoc`
at `fissionplane._api` or `fissionplane._dataplane`: those are generated cores,
and the OpenAPI files below are their reference.

Use `uv run pdoc fissionplane` without `-o` to preview the reference on a local
web server.

## API status

This package is version `0.0.1`. Treat its public API as unstable until the
project publishes a stable release.

The control-plane and data-plane OpenAPI files define the HTTP contracts:

- [Control-plane specification](https://github.com/ManuelAngel99/fissionplane/blob/main/src/contracts/openapi.yaml)
- [Data-plane specification](https://github.com/ManuelAngel99/fissionplane/blob/main/src/contracts/dataplane.yaml)

## License

FissionPlane uses the
[Apache License 2.0](https://github.com/ManuelAngel99/fissionplane/blob/main/LICENSE).
