import type { Dictionary } from './types'

export const zh: Dictionary = {
  meta: {
    title: 'FissionPlane — 自托管沙箱与无服务器函数',
    description:
      'FissionPlane 是一个开源平台，在你自己的基础设施上，用 Firecracker microVM 运行安全沙箱和无服务器函数。',
    imageAlt:
      'FissionPlane — 基于 Firecracker microVM 的自托管沙箱与无服务器函数',
  },
  nav: {
    contact: '联系',
    github: 'GitHub',
    githubTitle: 'GitHub 上的 FissionPlane 源代码',
    docs: '文档',
    docsTitle: 'FissionPlane 文档',
    homeAriaLabel: 'FissionPlane 首页',
  },
  hero: {
    heading: '在你自己的基础设施上运行安全沙箱与无服务器函数',
    body: 'FissionPlane 是一个基于 Firecracker microVM 构建的开源计算平台。为 AI 智能体在毫秒内创建交互式沙箱。部署可以缩容到零的函数。每一个字节都留在你自己运维的硬件上。',
  },
  platform: {
    heading: '部署到你自己的云上',
    tagline:
      '一个 Helm chart 即可把整个平台安装到任何 Kubernetes 集群：EKS、GKE、AKS，或你自己的机器。',
    note: '同样支持 k3s、裸金属和离线（air-gapped）网络。',
  },
  install: {
    heading: '接入 FissionPlane SDK',
    tagline: '用 TypeScript、Python 或 Rust 创建沙箱、部署函数。',
    groupLabel: '选择 SDK',
    copyLabel: '复制安装命令',
    copiedLabel: '已复制',
    copyCode: '复制代码',
    agentPrefix: '或者，',
    agentLink: '让你的 AI 智能体根据 OpenAPI 规范构建你自己的 SDK',
    copiedToast: '提示词已复制到剪贴板',
  },
  workloads: {
    heading: '两种工作负载。一个平台。',
    intro:
      '沙箱和函数运行在同一套底座之上：不可变模板、Firecracker microVM、快照和能力令牌。',
    sandboxes: {
      title: '沙箱',
      tagline: '为智能体和工具提供的有状态、可交互的 Linux 环境。',
      bullets: [
        '在毫秒内从模板创建沙箱。',
        '运行命令并流式传输 stdin、stdout 和 stderr。',
        '打开 PTY 会话、发送信号、监视文件。',
        '通过私有或公开的 HTTPS URL 暴露客户机端口。',
        '暂停到对象存储。恢复时进程原样保留。',
      ],
    },
    functions: {
      title: '函数',
      tagline: '代码只需部署一次，FissionPlane 按需运行。',
      bullets: [
        '从 OCI 镜像部署带版本的函数。',
        '通过 HTTPS 或按计划调用。',
        '从热快照毫秒级启动。',
        '调用之间缩容到零。',
        '一次调用即可回滚到之前的版本。',
      ],
    },
  },
  architecture: {
    heading: '一个集群。四个平面。',
    body: '控制平面决定什么在哪运行。网关把流量路由到正确的节点。节点运行时管理 microVM。客户机平面被视为不可信。控制平面从不代理工作负载流量，因此即使控制平面故障，运行中的沙箱和函数也会继续工作。',
    diagramLabel:
      '架构图：SDK 或 REST 客户端通过 HTTPS 连接到 Kubernetes 集群内的网关和控制平面。网关将流量转发给运行 Firecracker microVM 的 vm-host 节点。快照在节点与对象存储之间流转。',
  },
  useCases: {
    heading: 'FissionPlane 上运行什么',
    items: [
      {
        title: 'AI 智能体',
        body: '为每个智能体提供带独立内核的完整 Linux 工作区。',
      },
      {
        title: '代码解释器',
        body: '执行模型生成的代码，返回文件、图表和日志。',
      },
      {
        title: '无服务器 API',
        body: '把函数放在可缩容到零的 HTTPS 端点之后。',
      },
      {
        title: 'CI 与构建任务',
        body: '在干净的 microVM 中运行每个任务，结束后即销毁。',
      },
      {
        title: '数据分析',
        body: '在隔离环境中就近分析不可信的数据集。',
      },
      {
        title: '定时任务',
        body: '按计划运行函数。跑在自己硬件上的 cron。',
      },
    ],
  },
  what: {
    heading: 'FissionPlane 是什么？',
    body: 'FissionPlane 是一个面向不可信代码的自托管计算平台。它为 AI 智能体、代码解释器、开发工具和 CI 系统提供安全的运行环境。工作负载在你自己运维的 Kubernetes 节点上的 Firecracker microVM 中执行。',
    bullets: [
      {
        strong: '硬件级隔离。',
        text: '每个工作负载都运行在拥有独立内核、文件系统、网络命名空间和资源限制的 Firecracker microVM 中。',
      },
      {
        strong: '有状态沙箱。',
        text: '把沙箱暂停到对象存储。内存、进程和文件从停止处恢复。',
      },
      {
        strong: '无服务器函数。',
        text: '部署带版本的函数，从热快照启动并缩容到零。',
      },
      {
        strong: 'SDK 驱动控制。',
        text: '基于共享的 OpenAPI 契约，用 TypeScript、Python 或 Rust 管理一切。',
      },
      {
        strong: '完全自托管。',
        text: '控制平面、数据平面和计算都运行在你的基础设施上。无需任何专有服务。',
      },
      {
        strong: 'Kubernetes 原生。',
        text: '一个 Helm chart 即可装入现有集群。没有 Operator，没有自定义资源。',
      },
      {
        strong: '高韧性数据路径。',
        text: '控制平面故障时工作负载继续运行。控制平面从不代理流量。',
      },
    ],
    link: '阅读 FissionPlane 文档',
  },
  faq: {
    heading: '常见问题',
    items: [
      {
        question: 'FissionPlane 是什么？',
        answer:
          'FissionPlane 是一个用于安全执行代码的开源自托管平台。它在同一套底座上运行两类工作负载：交互式沙箱和无服务器函数。每个工作负载都在隔离的 Firecracker microVM 中执行，具备命令、文件系统、网络和生命周期控制。',
      },
      {
        question: 'FissionPlane 是开源的吗？',
        answer:
          '是的。FissionPlane 是遵循 Apache License 2.0 的自由开源软件。控制平面、网关、节点运行时、客户机程序、API 契约和 SDK 都在同一个仓库中。在遵守许可条款的前提下，你可以将其用于个人和商业项目。',
      },
      {
        question: '沙箱和函数有什么区别？',
        answer:
          '沙箱是有状态、可交互的。你创建它、运行命令、编辑文件，用完后删除。函数只部署一次，可以被多次调用。FissionPlane 会在每次调用时从热快照启动一个 microVM，运行你的处理函数，然后缩容回零。',
      },
      {
        question: 'FissionPlane 如何隔离不可信代码？',
        answer:
          '每个工作负载都运行在拥有独立内核、文件系统、网络命名空间和资源限制的 Firecracker microVM 中。工作负载与宿主机之间、彼此之间不共享任何东西。FissionPlane 把来自客户机的每一个字节都视为不可信。',
      },
      {
        question: 'FissionPlane 需要 Kubernetes 吗？',
        answer:
          '是的，就目前文档化的安装方式而言：一个 Helm chart 部署到现有的 Kubernetes 集群。不需要 Operator，不需要自定义资源，也不需要集群级别的改动。',
      },
      {
        question: 'FissionPlane 提供哪些 SDK？',
        answer:
          'TypeScript、Python 和 Rust。生命周期和数据平面 API 都使用 OpenAPI 契约，因此其他语言的客户端也可以遵循同样的契约。',
      },
      {
        question: 'FissionPlane 的沙箱可以暂停和恢复吗？',
        answer:
          '可以。你可以把沙箱暂停到对象存储，然后从停止处恢复它的内存、进程、文件系统和设备状态。',
      },
      {
        question: 'FissionPlane 与托管沙箱平台相比如何？',
        answer:
          '托管沙箱平台在它们的云上运行你的工作负载。FissionPlane 以自由软件的形式，在你自己的硬件上提供同样的原语——快速的 microVM 沙箱、快照和 SDK。没有按量计费，数据不会离开你的网络，还支持离线（air-gapped）部署。',
      },
      {
        question: '谁来运维 FissionPlane 的基础设施？',
        answer:
          '你自己。FissionPlane 不依赖任何专有云服务。控制平面、数据平面和计算都留在你自己运维的基础设施中。由于控制平面不代理流量，即使它发生故障，运行中的工作负载也会继续工作。',
      },
    ],
  },
  cta: {
    heading: '按你自己的规则运行不可信代码。',
    body: '用一个 Helm chart 在你的 Kubernetes 集群上安装控制平面。几分钟内创建第一个沙箱，或部署第一个函数。',
    link: '打开 FissionPlane 文档',
  },
  footer: {
    github: 'GitHub',
    docs: '文档',
    changelog: '更新日志',
    license: '许可证',
    brand: '品牌',
    privacy: '隐私',
    contact: '联系',
    languageLabel: '选择语言',
  },
  consent: {
    regionLabel: 'Cookie 提示',
    heading: 'Cookie 提示',
    body: '我们使用统计分析来了解本站的使用情况。没有广告，也不会跨站追踪你。',
    learnMore: '了解更多',
    allow: '接受',
    decline: '拒绝',
  },
  privacy: {
    metaTitle: '隐私 — FissionPlane',
    metaDescription:
      'FissionPlane 网站如何使用统计分析，以及如何更改你的选择。',
    heading: '隐私',
    subtitle: '本站如何使用统计分析。',
    choice: {
      heading: '你的选择',
      allowed: '统计分析已开启。',
      declined: '统计分析已关闭。',
      undecided: '你还没有做出选择。在此之前统计分析保持关闭。',
      signalled: '你的浏览器要求不被追踪，因此统计分析保持关闭。',
      allow: '接受统计分析',
      decline: '拒绝统计分析',
    },
    sections: [
      {
        heading: '统计分析',
        body: '我们使用 Cloudflare Web Analytics 统计页面浏览量。它不设置 Cookie，不在你的设备上存储任何内容，也不会跨站追踪你。只有在你接受后才会加载。',
      },
      {
        heading: '你的数据',
        body: '我们不投放广告，不出售或共享你的数据，也不为你建立画像。你的选择保存在浏览器中，永远不会离开你的设备。清除本站数据后，我们会再次询问。',
      },
    ],
  },
  brand: {
    metaTitle: 'FissionPlane 品牌指南',
    metaDescription:
      'FissionPlane 品牌的标志、字标、配色与使用规范。可下载 SVG 和 PNG 格式的素材。',
    heading: '品牌指南',
    subtitle: 'FissionPlane 品牌的资源与素材。',
    downloadAll: '下载全部素材',
    assets: {
      icon: '图标',
      wordmark: '字标',
      lockup: '组合标志',
      darkVariant: '用于浅色背景',
      lightVariant: '用于深色背景',
    },
    svgLabel: 'SVG',
    pngLabel: 'PNG',
    usageHeading: '使用规范',
    usageRules: [
      '空间充足时使用组合标志。小尺寸场景使用图标。',
      '保持像素网格完整。按整数倍缩放标志。',
      '不要改色、拉伸、旋转标志，也不要添加效果。',
      '标志四周保留与图标高度相等的留白。',
    ],
    colorsHeading: '配色',
    colorsIntro: 'FissionPlane 使用一套暖灰色调色板。标志使用以下四种灰色。',
  },
  contact: {
    metaTitle: '联系 — FissionPlane',
    metaDescription: '联系 FissionPlane 的开发者 Manuel Suarez。',
    heading: '联系',
    subtitle: '有问题、反馈或部署方面的需求，欢迎联系我。',
    directHeading: '直接联系',
    directBody:
      'FissionPlane 由 Manuel Suarez 开发。你可以发邮件，或通过以下方式找到我：',
    emailChannel: '邮箱',
    formHeading: '发送消息',
    formTagline: '每条消息我都会阅读，并通过邮件回复。',
    emailLabel: '你的邮箱',
    messageLabel: '消息',
    messageHint: '最多 3,000 个字符。',
    submit: '发送消息',
    sending: '发送中…',
    success: '消息已发送，我会尽快回复。',
    error: '发送失败，请直接给我发邮件。',
  },
  notFound: {
    title: '页面不存在 — FissionPlane',
    heading: '页面不存在',
    body: '这个页面不存在。',
    homeLink: '返回首页。',
  },
}
