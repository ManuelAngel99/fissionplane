# FissionPlane Rust SDK

Use FissionPlane to create and control isolated sandboxes on your own
infrastructure. The `fissionplane` crate connects Rust applications to an
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

- Rust 1.97 or later
- A Tokio runtime
- An FissionPlane control plane URL
- An API key or OIDC bearer token
- A template alias or template artifact ID

## Install

Add the crate:

```bash
cargo add fissionplane
```

The SDK is asynchronous. Add Tokio if your application does not already use
it:

```bash
cargo add tokio --features macros,rt-multi-thread
```

## Configure the client

Set the control plane URL and API key:

```bash
export FISSIONPLANE_API_URL="https://api.sandbox.example.com"
export FISSIONPLANE_API_KEY="your-api-key"
```

`ClientOptions::new()` reads both variables when you construct the client:

```rust
use fissionplane::{ClientOptions, FissionPlane};

let client = FissionPlane::new(ClientOptions::new())?;
```

You can also pass the values directly:

```rust
let client = FissionPlane::new(
    ClientOptions::new()
        .base_url("https://api.sandbox.example.com")
        .api_key("your-api-key"),
)?;
```

Use `ClientOptions::access_token()` instead of `api_key()` for an OIDC bearer
token. An explicit API key takes precedence over an access token. The client
rejects an empty credential, or one that carries whitespace from a shell or a
secret store, with `Error::Config` instead of sending it and reporting a 401.

### Timeouts, retries, and the user agent

Every request has a 60 second deadline, replays a failed read up to twice, and
identifies the SDK with `User-Agent: fissionplane-rust/<version>`. Change any of
those:

```rust,no_run
use std::time::Duration;

use fissionplane::{ClientOptions, FissionPlane};

# fn configure() -> Result<(), fissionplane::Error> {
let client = FissionPlane::new(
    ClientOptions::new()
        .request_timeout(Duration::from_secs(10))
        .max_retries(4)
        .user_agent("acme-batch/2.1"),
)?;
# let _ = client;
# Ok(())
# }
```

- `request_timeout()` bounds one attempt on either plane, including reading the
  response body, and bounds a WebSocket handshake. `Duration::ZERO` disables it.
  The default is `DEFAULT_REQUEST_TIMEOUT`.
- `max_retries()` bounds the retries after a first failed attempt, spaced by
  exponential backoff with full jitter. `0` disables them. The default is
  `DEFAULT_MAX_RETRIES`.
- `user_agent()` replaces the default on both the control plane and the sandbox
  data plane.

The SDK retries a request only when both are true: the failure is worth
repeating (a connect or timeout failure, a 429, a 5xx, or an error document
whose `retryable` is true), and repeating the request cannot create a second
effect. The second condition means reads are retried and writes are not, unless
the write carries an idempotency key — which is why `Sandboxes::create()` takes
one. An error document with `retryable: false` is never retried.

## Create a sandbox and run a command

Sandbox creation returns after a node acknowledges the sandbox.

```rust,no_run
use fissionplane::models::{CreateSandboxRequest, RunCommandRequest};
use fissionplane::{ClientOptions, FissionPlane};

#[tokio::main]
async fn main() -> Result<(), fissionplane::Error> {
    let client = FissionPlane::new(ClientOptions::new())?;

    let sandbox = client
        .sandboxes()
        .create(
            CreateSandboxRequest {
                template: "base".to_owned(),
                name: Some("example-job".to_owned()),
                deadline_seconds: Some(600),
                ..Default::default()
            },
            Some("example-job-1"),
        )
        .await?;

    let result = sandbox
        .commands()?
        .run(RunCommandRequest {
            command: "sh".to_owned(),
            args: Some(vec![
                "-c".to_owned(),
                "printf 'hello from FissionPlane\\n'".to_owned(),
            ]),
            timeout_seconds: Some(30),
            ..Default::default()
        })
        .await?;

    println!("{}", result.stdout);
    println!("exit code: {}", result.exit_code);
    sandbox.delete().await?;
    Ok(())
}
```

`Commands::run()` waits for the command to exit. It returns the exit code,
standard output, standard error, and an optional truncation flag.

Use `Commands::list_processes()` to list supervised processes. Use
`Commands::kill(pid, Some(Signal::Term))` to signal one process.

Start a background process when output must be followed or stdin stays open:

```rust,no_run
use futures_util::StreamExt;
use fissionplane::models::{ProcessStreamEvent, PtySize, StartProcessRequest};

# async fn stream(sandbox: &fissionplane::Sandbox) -> Result<(), fissionplane::Error> {
let process = sandbox.commands()?.start(StartProcessRequest {
    command: "bash".to_owned(),
    pty: Some(PtySize { cols: 120, rows: 40 }),
    ..Default::default()
}).await?;
let mut attachment = process.attach(0).await?;
attachment.send_input("pwd\n").await?;

while let Some(event) = attachment.next().await {
    if matches!(event?, ProcessStreamEvent::Exit { .. }) {
        break;
    }
}
# Ok(())
# }
```

Filesystem operations are available from `sandbox.files()?`; they include
metadata, directory mutation, byte uploads and downloads, and recursive
WebSocket watches.

## Manage the sandbox lifecycle

A sandbox has one of four visible states: `Running`, `Paused`, `Terminated`,
or `Failed`.

```rust,no_run
# async fn lifecycle(
#     mut sandbox: fissionplane::Sandbox,
# ) -> Result<(), fissionplane::Error> {
sandbox.pause().await?;
sandbox.resume(Some(600)).await?;
sandbox.extend_deadline(900).await?;
sandbox.delete().await?;
# Ok(())
# }
```

`pause()` saves a snapshot and releases node capacity. `resume()` restores the
snapshot on a node. A resumed sandbox has a new epoch.

Capability tokens belong to one sandbox epoch. The SDK replaces the token on
the handle after `resume()`. A handle returned by `Sandboxes::get()` or
`Sandboxes::list()` has no token. Call `Sandbox::mint_token()` before you
create a `Commands` handle from it.

A `Commands` or `Files` value keeps working across a resume. When the sandbox
agent rejects its token, the SDK mints a replacement through the control plane
and replays the call once; a WebSocket handshake the agent rejects reconnects
the same way. The replacement keeps the port scope of the token it replaces, so
a refresh never widens an attenuated token. Read `Sandbox::current_token()` to
see a token minted that way: `Sandbox::token` holds what the handle itself last
stored, and a data-plane call cannot write to it.

Use an idempotency key when your application can retry sandbox creation. The
same key returns the sandbox from the first successful request, and it is also
what lets the SDK replay the create itself after a transient failure.

## Expose a port

Every port is private by default. Private access requires a capability token.
Make one port public only when anonymous access is required.

```rust,no_run
use fissionplane::models::PortVisibility;

# async fn ports(sandbox: &fissionplane::Sandbox) -> Result<(), fissionplane::Error> {
let ports = sandbox.ports();
let exposure = ports.expose(3000, PortVisibility::Public).await?;
println!("{}", exposure.url);

let records = ports.list().await?;
println!("{} exposure records", records.items.len());
ports.unexpose(3000).await?;
# Ok(())
# }
```

`unexpose()` removes the exposure record. The port then returns to private
access.

## Build and use a template

Template builds run asynchronously on the FissionPlane installation.

```rust,no_run
use fissionplane::models::CreateTemplateBuildRequest;
use fissionplane::WaitOptions;

# async fn build_template(
#     client: &fissionplane::FissionPlane,
# ) -> Result<(), fissionplane::Error> {
let mut build = client
    .templates()
    .build(CreateTemplateBuildRequest {
        image: "python:3.12".to_owned(),
        alias: Some("python-tools".to_owned()),
        ..Default::default()
    })
    .await?;

let template = build.wait(WaitOptions::default()).await?;
println!("{:?}", template.artifact_id);
# Ok(())
# }
```

Use `TemplateBuildHandle::logs(offset)` to read build output. Pass
`next_offset` to the next call. Use `Templates::get_build(build_id)` to
reconnect to an existing build.

## List sandboxes

Read one page with `list()`:

```rust,no_run
use fissionplane::{ListSandboxesFilter, FissionPlane};
use fissionplane::models::SandboxState;

# async fn list(client: &FissionPlane) -> Result<(), fissionplane::Error> {
let page = client
    .sandboxes()
    .list(ListSandboxesFilter {
        state: Some(SandboxState::Running),
        limit: Some(20),
        ..Default::default()
    })
    .await?;
println!("{} sandboxes", page.items.len());
# Ok(())
# }
```

Use `Sandboxes::stream()` to walk every page, fetching the next one only when
the current one runs out:

```rust,no_run
use futures_util::StreamExt;
use fissionplane::{ListSandboxesFilter, FissionPlane};

# async fn walk(client: &FissionPlane) -> Result<(), fissionplane::Error> {
let sandboxes = client.sandboxes();
let mut all = sandboxes.stream(ListSandboxesFilter::default());
while let Some(sandbox) = all.next().await {
    println!("{}", sandbox?.info.sandbox_id);
}
# Ok(())
# }
```

The stream ends after the first error, so a `?` inside the loop reports it. Use
`Sandboxes::list_all()` instead when the whole collection should be in memory at
once.

## Handle errors

Every SDK operation returns `fissionplane::Error`.

```rust,no_run
use fissionplane::Error;

# async fn create(client: &fissionplane::FissionPlane) -> Result<(), Error> {
let result = client
    .sandboxes()
    .create(
        fissionplane::models::CreateSandboxRequest {
            template: "base".to_owned(),
            ..Default::default()
        },
        None,
    )
    .await;

match result {
    Ok(sandbox) => println!("{}", sandbox.info.sandbox_id),
    Err(Error::Api {
        code,
        retryable: true,
        request_id,
        ..
    }) => {
        eprintln!("retry later: {code:?}, request ID: {request_id:?}");
    }
    Err(error) => return Err(error),
}
# Ok(())
# }
```

`Error` distinguishes transport errors, API errors, missing capability
tokens, failed template builds, wait timeouts, and invalid configuration.

## See what the SDK is doing

The SDK emits `tracing` events at the `DEBUG` level when it replays a request,
re-mints a capability token, or fetches a page of sandboxes. Install any
`tracing` subscriber to see them; without one they cost nothing.

```rust,no_run
tracing_subscriber::fmt()
    .with_env_filter("fissionplane=debug")
    .init();
```

Credentials and capability tokens never appear in an event or in a `Debug`
rendering of `ClientOptions`.

## Control plane and data plane

The control plane manages sandboxes, ports, tokens, and templates. The
sandbox data plane runs commands, streams process I/O, and accesses files.

The SDK sends your API key or OIDC token to the control plane. It sends a
short-lived capability token to the sandbox data plane. The `Sandbox` handle
stores that token.

The data-plane agent uses port `50000` by default. Set
`ClientOptions::agent_port()` only when your installation uses a different
port.

## API status

This crate is version `0.0.1`. Treat its public API as unstable until the
project publishes a stable release.

The control-plane and data-plane OpenAPI files define the HTTP contracts:

- [Control-plane specification](https://github.com/ManuelAngel99/fissionplane/blob/main/src/contracts/openapi.yaml)
- [Data-plane specification](https://github.com/ManuelAngel99/fissionplane/blob/main/src/contracts/dataplane.yaml)

## License

FissionPlane uses the
[Apache License 2.0](https://github.com/ManuelAngel99/fissionplane/blob/main/LICENSE).
