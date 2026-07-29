# Source: https://fissionplane.dev/

# Run secure sandboxes and serverless functions on your own infrastructure

FissionPlane is an open-source compute platform built on Firecracker microVMs. Create interactive sandboxes for AI agents in milliseconds. Deploy functions that scale to zero. Every byte stays on hardware you operate.

## Deploy it on your own cloud

One Helm chart installs the whole platform on any Kubernetes cluster: EKS, GKE, AKS, or your own machines.

![][base64-image]

- AWS
- Google Cloud
- Azure
- Kubernetes

Also runs on k3s, bare metal, and air-gapped networks.

## Connect a FissionPlane SDK

Create sandboxes and deploy functions from TypeScript, Python, or Rust.

TypeScriptPythonRust

npm install @fissionplane/sdk

```
import { FissionPlane } from '@fissionplane/sdk'

const client = new FissionPlane()
const sandbox = await client.sandboxes.create({ template: 'base' })

const result = await sandbox.commands.run('echo', {
  args: ['hello from a microVM'],
})

console.log(result.stdout)
await sandbox.delete()
```

pip install fissionplane

```
from fissionplane import FissionPlane

client = FissionPlane()
sandbox = client.sandboxes.create("base")

result = sandbox.commands.run(
    "echo",
    args=["hello from a microVM"],
)

print(result.stdout)
sandbox.delete()
```

cargo add fissionplane

```
use fissionplane::models::{CreateSandboxRequest, RunCommandRequest};
use fissionplane::{ClientOptions, FissionPlane};

#[tokio::main]
async fn main() -> Result<(), fissionplane::Error> {
    let client = FissionPlane::new(ClientOptions::new())?;

    let request = CreateSandboxRequest {
        template: "base".to_owned(),
        ..Default::default()
    };
    let sandbox = client.sandboxes().create(request, None).await?;

    let run = RunCommandRequest {
        command: "echo".to_owned(),
        args: Some(vec!["hello from a microVM".to_owned()]),
        ..Default::default()
    };
    let result = sandbox.commands()?.run(run).await?;

    println!("{}", result.stdout);
    sandbox.delete().await?;
    Ok(())
}
```

Or let your AI agent build your own SDK from the OpenAPI spec

## Two workloads. One platform.

Sandboxes and functions run on the same substrate: immutable templates, Firecracker microVMs, snapshots, and capability tokens.

### Sandboxes

Stateful, interactive Linux environments for agents and tools.

- Create a sandbox from a template in milliseconds.
- Run commands and stream stdin, stdout, and stderr.
- Open PTY sessions, send signals, and watch files.
- Expose guest ports through private or public HTTPS URLs.
- Pause to object storage. Resume with processes intact.

### Functions

Deploy code once. FissionPlane runs it on demand.

- Deploy versioned functions from OCI images.
- Invoke over HTTPS or on a schedule.
- Start from warm snapshots in milliseconds.
- Scale to zero between invocations.
- Roll back to a previous version with one call.

## One cluster. Four planes.

The control plane decides what runs and where. The gateway routes traffic to the right node. The node runtime owns the microVMs. The guest plane is assumed hostile. The control plane never proxies workload traffic, so running sandboxes and functions continue through a control-plane outage.

```
                 ╔═ your kubernetes cluster ═══════════════════════════╗ 
╔══════════════╗ ║   ┌───────────────┐          ┌──────────────────┐   ║░
║  SDK / REST  ║─╫──▶│    gateway    │──mTLS───▶│  node · vm-host  │   ║░
╚══════════════╝ ║   │ TLS · routing │          │  ┌────────────┐  │   ║░
 ░░░░░░░░░░░░░░  ║   └───────────────┘          │  │ ▪ microVM  │  │   ║░
                 ║   ┌───────────────┐          │  │ ▪ microVM  │  │   ║░
                 ║   │ control plane │──gRPC───▶│  │ ▪ microVM  │  │   ║░
                 ║   │ place · quota │          │  └────────────┘  │   ║░
                 ║   └───────────────┘          └────────┬─────────┘   ║░
                 ║                                 pause │ resume      ║░
                 ║                              ┌────────▼─────────┐   ║░
                 ║                              │  object storage  │   ║░
                 ║                              └──────────────────┘   ║░
                 ╚═════════════════════════════════════════════════════╝░
                  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

## What runs on FissionPlane

- ### AI agents

 Give each agent a full Linux workspace with its own kernel.

- ### Code interpreters

 Execute model-generated code. Return files, charts, and logs.

- ### Serverless APIs

 Put functions behind HTTPS endpoints that scale to zero.

- ### CI and build jobs

 Run each job in a clean microVM. Destroy it when the job ends.

- ### Data analysis

 Analyze untrusted datasets in isolation, next to your data.

- ### Scheduled jobs

 Run functions on a schedule. Cron, on your own hardware.

## What is FissionPlane?

FissionPlane is a self-hosted compute platform for untrusted code. It gives AI agents, code interpreters, developer tools, and CI systems a secure place to run. Workloads execute in Firecracker microVMs on Kubernetes nodes that you operate.

- **Hardware isolation.** Each workload runs in a Firecracker microVM with its own kernel, filesystem, network namespace, and resource limits.
- **Stateful sandboxes.** Pause a sandbox to object storage. Resume its memory, processes, and files where they stopped.
- **Serverless functions.** Deploy versioned functions that start from warm snapshots and scale to zero.
- **SDK-driven control.** Manage everything from TypeScript, Python, or Rust against shared OpenAPI contracts.
- **Fully self-hosted.** The control plane, data plane, and compute run on your infrastructure. No proprietary service required.
- **Kubernetes-native.** One Helm chart installs into an existing cluster. No operator. No custom resources.
- **Resilient data path.** Workloads keep running through a control-plane outage. The control plane never proxies traffic.

[Read the FissionPlane documentation](https://docs.fissionplane.dev)

## Frequently asked questions

- ### What is FissionPlane?

 FissionPlane is an open-source, self-hosted platform for secure code execution. It runs two workload types on one substrate: interactive sandboxes and serverless functions. Each workload executes in an isolated Firecracker microVM with command, filesystem, network, and lifecycle controls.

- ### Is FissionPlane open source?

 Yes. FissionPlane is free and open-source software under the Apache License 2.0. The control plane, gateway, node runtime, guest programs, API contracts, and SDKs are all in one repository. You may use it in personal and commercial projects, subject to the license terms.

- ### What is the difference between a sandbox and a function?

 A sandbox is stateful and interactive. You create it, run commands, edit files, and delete it when you finish. A function is deployed once and invoked many times. FissionPlane starts a microVM from a warm snapshot for each invocation, runs your handler, and scales back to zero.

- ### How does FissionPlane isolate untrusted code?

 Each workload runs in a Firecracker microVM with its own kernel, filesystem, network namespace, and resource limits. Workloads share nothing with the host or with each other. FissionPlane treats every byte from the guest as hostile.

- ### Does FissionPlane require Kubernetes?

 Yes for the install path documented today: one Helm chart deploys into an existing Kubernetes cluster. It needs no operator, no custom resources, and no cluster-wide changes.

- ### Which SDKs does FissionPlane provide?

 TypeScript, Python, and Rust. Lifecycle and data-plane APIs use OpenAPI contracts, so clients can follow the same contracts in other languages.

- ### Can FissionPlane sandboxes be paused and resumed?

 Yes. You can pause a sandbox to object storage and resume its memory, processes, filesystem, and device state where they stopped.

- ### How does FissionPlane compare to hosted sandbox platforms?

 Hosted sandbox platforms run your workloads on their cloud. FissionPlane gives you the same primitives — fast microVM sandboxes, snapshots, and SDKs — as free software on your own hardware. There is no metered billing, no data leaves your network, and air-gapped installs work.

- ### Who operates the FissionPlane infrastructure?

 You do. FissionPlane requires no proprietary cloud service. The control plane, data plane, and compute stay in infrastructure that you operate. Running workloads continue through a control-plane outage because the control plane does not proxy their traffic.

**Run untrusted code on your own terms.**

Install the control plane on your Kubernetes cluster with one Helm chart. Create your first sandbox or deploy your first function in minutes.

[Open the FissionPlane documentation](https://docs.fissionplane.dev)