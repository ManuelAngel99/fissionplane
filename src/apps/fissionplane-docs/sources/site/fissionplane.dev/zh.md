# Source: https://fissionplane.dev/zh

# 在你自己的基础设施上运行安全沙箱与无服务器函数

FissionPlane 是一个基于 Firecracker microVM 构建的开源计算平台。为 AI 智能体在毫秒内创建交互式沙箱。部署可以缩容到零的函数。每一个字节都留在你自己运维的硬件上。

## 部署到你自己的云上

一个 Helm chart 即可把整个平台安装到任何 Kubernetes 集群：EKS、GKE、AKS，或你自己的机器。

![][base64-image]

- AWS
- Google Cloud
- Azure
- Kubernetes

同样支持 k3s、裸金属和离线（air-gapped）网络。

## 接入 FissionPlane SDK

用 TypeScript、Python 或 Rust 创建沙箱、部署函数。

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

或者， 让你的 AI 代理根据 OpenAPI 规范构建你自己的 SDK

## 两种工作负载。一个平台。

沙箱和函数运行在同一套底座之上：不可变模板、Firecracker microVM、快照和能力令牌。

### 沙箱

为智能体和工具提供的有状态、可交互的 Linux 环境。

- 在毫秒内从模板创建沙箱。
- 运行命令并流式传输 stdin、stdout 和 stderr。
- 打开 PTY 会话、发送信号、监视文件。
- 通过私有或公开的 HTTPS URL 暴露客户机端口。
- 暂停到对象存储。恢复时进程原样保留。

### 函数

代码只需部署一次，FissionPlane 按需运行。

- 从 OCI 镜像部署带版本的函数。
- 通过 HTTPS 或按计划调用。
- 从热快照毫秒级启动。
- 调用之间缩容到零。
- 一次调用即可回滚到之前的版本。

## 一个集群。四个平面。

控制平面决定什么在哪运行。网关把流量路由到正确的节点。节点运行时管理 microVM。客户机平面被视为不可信。控制平面从不代理工作负载流量，因此即使控制平面故障，运行中的沙箱和函数也会继续工作。

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

## FissionPlane 上运行什么

- ### AI 智能体

 为每个智能体提供带独立内核的完整 Linux 工作区。

- ### 代码解释器

 执行模型生成的代码，返回文件、图表和日志。

- ### 无服务器 API

 把函数放在可缩容到零的 HTTPS 端点之后。

- ### CI 与构建任务

 在干净的 microVM 中运行每个任务，结束后即销毁。

- ### 数据分析

 在隔离环境中就近分析不可信的数据集。

- ### 定时任务

 按计划运行函数。跑在自己硬件上的 cron。

## FissionPlane 是什么？

FissionPlane 是一个面向不可信代码的自托管计算平台。它为 AI 智能体、代码解释器、开发工具和 CI 系统提供安全的运行环境。工作负载在你自己运维的 Kubernetes 节点上的 Firecracker microVM 中执行。

- **硬件级隔离。** 每个工作负载都运行在拥有独立内核、文件系统、网络命名空间和资源限制的 Firecracker microVM 中。
- **有状态沙箱。** 把沙箱暂停到对象存储。内存、进程和文件从停止处恢复。
- **无服务器函数。** 部署带版本的函数，从热快照启动并缩容到零。
- **SDK 驱动控制。** 基于共享的 OpenAPI 契约，用 TypeScript、Python 或 Rust 管理一切。
- **完全自托管。** 控制平面、数据平面和计算都运行在你的基础设施上。无需任何专有服务。
- **Kubernetes 原生。** 一个 Helm chart 即可装入现有集群。没有 Operator，没有自定义资源。
- **高韧性数据路径。** 控制平面故障时工作负载继续运行。控制平面从不代理流量。

[阅读 FissionPlane 文档](https://docs.fissionplane.dev)

## 常见问题

- ### FissionPlane 是什么？

 FissionPlane 是一个用于安全执行代码的开源自托管平台。它在同一套底座上运行两类工作负载：交互式沙箱和无服务器函数。每个工作负载都在隔离的 Firecracker microVM 中执行，具备命令、文件系统、网络和生命周期控制。

- ### FissionPlane 是开源的吗？

 是的。FissionPlane 是遵循 Apache License 2.0 的自由开源软件。控制平面、网关、节点运行时、客户机程序、API 契约和 SDK 都在同一个仓库中。在遵守许可条款的前提下，你可以将其用于个人和商业项目。

- ### 沙箱和函数有什么区别？

 沙箱是有状态、可交互的。你创建它、运行命令、编辑文件，用完后删除。函数只部署一次，可以被多次调用。FissionPlane 会在每次调用时从热快照启动一个 microVM，运行你的处理函数，然后缩容回零。

- ### FissionPlane 如何隔离不可信代码？

 每个工作负载都运行在拥有独立内核、文件系统、网络命名空间和资源限制的 Firecracker microVM 中。工作负载与宿主机之间、彼此之间不共享任何东西。FissionPlane 把来自客户机的每一个字节都视为不可信。

- ### FissionPlane 需要 Kubernetes 吗？

 是的，就目前文档化的安装方式而言：一个 Helm chart 部署到现有的 Kubernetes 集群。不需要 Operator，不需要自定义资源，也不需要集群级别的改动。

- ### FissionPlane 提供哪些 SDK？

 TypeScript、Python 和 Rust。生命周期和数据平面 API 都使用 OpenAPI 契约，因此其他语言的客户端也可以遵循同样的契约。

- ### FissionPlane 的沙箱可以暂停和恢复吗？

 可以。你可以把沙箱暂停到对象存储，然后从停止处恢复它的内存、进程、文件系统和设备状态。

- ### FissionPlane 与托管沙箱平台相比如何？

 托管沙箱平台在它们的云上运行你的工作负载。FissionPlane 以自由软件的形式，在你自己的硬件上提供同样的原语——快速的 microVM 沙箱、快照和 SDK。没有按量计费，数据不会离开你的网络，还支持离线（air-gapped）部署。

- ### 谁来运维 FissionPlane 的基础设施？

 你自己。FissionPlane 不依赖任何专有云服务。控制平面、数据平面和计算都留在你自己运维的基础设施中。由于控制平面不代理流量，即使它发生故障，运行中的工作负载也会继续工作。

**按你自己的规则运行不可信代码。**

用一个 Helm chart 在你的 Kubernetes 集群上安装控制平面。几分钟内创建第一个沙箱，或部署第一个函数。

[打开 FissionPlane 文档](https://docs.fissionplane.dev)