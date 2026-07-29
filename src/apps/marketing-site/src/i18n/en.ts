import type { Dictionary } from './types'

/**
 * English master copy. Style: The Elements of Style (omit needless words,
 * active voice) and ASD-STE100 (short sentences, one idea per sentence,
 * consistent terms). Technical terms stay constant across the page:
 * sandbox, function, microVM, template, control plane, snapshot.
 */
export const en: Dictionary = {
  meta: {
    title: 'FissionPlane — Self-hosted sandboxes and serverless functions',
    description:
      'FissionPlane is an open-source platform that runs secure sandboxes and serverless functions in Firecracker microVMs on infrastructure you operate.',
    imageAlt:
      'FissionPlane — self-hosted sandboxes and serverless functions on Firecracker microVMs',
  },
  nav: {
    contact: 'Contact',
    github: 'GitHub',
    githubTitle: 'FissionPlane source code on GitHub',
    docs: 'Docs',
    docsTitle: 'FissionPlane documentation',
    homeAriaLabel: 'FissionPlane home',
  },
  hero: {
    heading:
      'Run secure sandboxes and serverless functions on your own infrastructure',
    body: 'FissionPlane is an open-source compute platform built on Firecracker microVMs. Create interactive sandboxes for AI agents in milliseconds. Deploy functions that scale to zero. Every byte stays on hardware you operate.',
  },
  platform: {
    heading: 'Deploy it on your own cloud',
    tagline:
      'One Helm chart installs the whole platform on any Kubernetes cluster: EKS, GKE, AKS, or your own machines.',
    note: 'Also runs on k3s, bare metal, and air-gapped networks.',
  },
  install: {
    heading: 'Connect a FissionPlane SDK',
    tagline:
      'Create sandboxes and deploy functions from TypeScript, Python, or Rust.',
    groupLabel: 'Choose an SDK',
    copyLabel: 'Copy install command',
    copiedLabel: 'Copied',
    copyCode: 'Copy code',
    agentPrefix: 'Or',
    agentLink: 'let your AI agent build your own SDK from the OpenAPI spec',
    copiedToast: 'Prompt copied to clipboard',
  },
  workloads: {
    heading: 'Two workloads. One platform.',
    intro:
      'Sandboxes and functions run on the same substrate: immutable templates, Firecracker microVMs, snapshots, and capability tokens.',
    sandboxes: {
      title: 'Sandboxes',
      tagline: 'Stateful, interactive Linux environments for agents and tools.',
      bullets: [
        'Create a sandbox from a template in milliseconds.',
        'Run commands and stream stdin, stdout, and stderr.',
        'Open PTY sessions, send signals, and watch files.',
        'Expose guest ports through private or public HTTPS URLs.',
        'Pause to object storage. Resume with processes intact.',
      ],
    },
    functions: {
      title: 'Functions',
      tagline: 'Deploy code once. FissionPlane runs it on demand.',
      bullets: [
        'Deploy versioned functions from OCI images.',
        'Invoke over HTTPS or on a schedule.',
        'Start from warm snapshots in milliseconds.',
        'Scale to zero between invocations.',
        'Roll back to a previous version with one call.',
      ],
    },
  },
  architecture: {
    heading: 'One cluster. Four planes.',
    body: 'The control plane decides what runs and where. The gateway routes traffic to the right node. The node runtime owns the microVMs. The guest plane is assumed hostile. The control plane never proxies workload traffic, so running sandboxes and functions continue through a control-plane outage.',
    diagramLabel:
      'Architecture diagram: an SDK or REST client connects over HTTPS to a gateway and a control plane inside your Kubernetes cluster. The gateway proxies traffic to vm-host nodes that run Firecracker microVMs. Snapshots move between nodes and object storage.',
  },
  useCases: {
    heading: 'What runs on FissionPlane',
    items: [
      {
        title: 'AI agents',
        body: 'Give each agent a full Linux workspace with its own kernel.',
      },
      {
        title: 'Code interpreters',
        body: 'Execute model-generated code. Return files, charts, and logs.',
      },
      {
        title: 'Serverless APIs',
        body: 'Put functions behind HTTPS endpoints that scale to zero.',
      },
      {
        title: 'CI and build jobs',
        body: 'Run each job in a clean microVM. Destroy it when the job ends.',
      },
      {
        title: 'Data analysis',
        body: 'Analyze untrusted datasets in isolation, next to your data.',
      },
      {
        title: 'Scheduled jobs',
        body: 'Run functions on a schedule. Cron, on your own hardware.',
      },
    ],
  },
  what: {
    heading: 'What is FissionPlane?',
    body: 'FissionPlane is a self-hosted compute platform for untrusted code. It gives AI agents, code interpreters, developer tools, and CI systems a secure place to run. Workloads execute in Firecracker microVMs on Kubernetes nodes that you operate.',
    bullets: [
      {
        strong: 'Hardware isolation.',
        text: 'Each workload runs in a Firecracker microVM with its own kernel, filesystem, network namespace, and resource limits.',
      },
      {
        strong: 'Stateful sandboxes.',
        text: 'Pause a sandbox to object storage. Resume its memory, processes, and files where they stopped.',
      },
      {
        strong: 'Serverless functions.',
        text: 'Deploy versioned functions that start from warm snapshots and scale to zero.',
      },
      {
        strong: 'SDK-driven control.',
        text: 'Manage everything from TypeScript, Python, or Rust against shared OpenAPI contracts.',
      },
      {
        strong: 'Fully self-hosted.',
        text: 'The control plane, data plane, and compute run on your infrastructure. No proprietary service required.',
      },
      {
        strong: 'Kubernetes-native.',
        text: 'One Helm chart installs into an existing cluster. No operator. No custom resources.',
      },
      {
        strong: 'Resilient data path.',
        text: 'Workloads keep running through a control-plane outage. The control plane never proxies traffic.',
      },
    ],
    link: 'Read the FissionPlane documentation',
  },
  faq: {
    heading: 'Frequently asked questions',
    items: [
      {
        question: 'What is FissionPlane?',
        answer:
          'FissionPlane is an open-source, self-hosted platform for secure code execution. It runs two workload types on one substrate: interactive sandboxes and serverless functions. Each workload executes in an isolated Firecracker microVM with command, filesystem, network, and lifecycle controls.',
      },
      {
        question: 'Is FissionPlane open source?',
        answer:
          'Yes. FissionPlane is free and open-source software under the Apache License 2.0. The control plane, gateway, node runtime, guest programs, API contracts, and SDKs are all in one repository. You may use it in personal and commercial projects, subject to the license terms.',
      },
      {
        question: 'What is the difference between a sandbox and a function?',
        answer:
          'A sandbox is stateful and interactive. You create it, run commands, edit files, and delete it when you finish. A function is deployed once and invoked many times. FissionPlane starts a microVM from a warm snapshot for each invocation, runs your handler, and scales back to zero.',
      },
      {
        question: 'How does FissionPlane isolate untrusted code?',
        answer:
          'Each workload runs in a Firecracker microVM with its own kernel, filesystem, network namespace, and resource limits. Workloads share nothing with the host or with each other. FissionPlane treats every byte from the guest as hostile.',
      },
      {
        question: 'Does FissionPlane require Kubernetes?',
        answer:
          'Yes for the install path documented today: one Helm chart deploys into an existing Kubernetes cluster. It needs no operator, no custom resources, and no cluster-wide changes.',
      },
      {
        question: 'Which SDKs does FissionPlane provide?',
        answer:
          'TypeScript, Python, and Rust. Lifecycle and data-plane APIs use OpenAPI contracts, so clients can follow the same contracts in other languages.',
      },
      {
        question: 'Can FissionPlane sandboxes be paused and resumed?',
        answer:
          'Yes. You can pause a sandbox to object storage and resume its memory, processes, filesystem, and device state where they stopped.',
      },
      {
        question: 'How does FissionPlane compare to hosted sandbox platforms?',
        answer:
          'Hosted sandbox platforms run your workloads on their cloud. FissionPlane gives you the same primitives — fast microVM sandboxes, snapshots, and SDKs — as free software on your own hardware. There is no metered billing, no data leaves your network, and air-gapped installs work.',
      },
      {
        question: 'Who operates the FissionPlane infrastructure?',
        answer:
          'You do. FissionPlane requires no proprietary cloud service. The control plane, data plane, and compute stay in infrastructure that you operate. Running workloads continue through a control-plane outage because the control plane does not proxy their traffic.',
      },
    ],
  },
  cta: {
    heading: 'Run untrusted code on your own terms.',
    body: 'Install the control plane on your Kubernetes cluster with one Helm chart. Create your first sandbox or deploy your first function in minutes.',
    link: 'Open the FissionPlane documentation',
  },
  footer: {
    github: 'GitHub',
    docs: 'Docs',
    changelog: 'Changelog',
    license: 'License',
    brand: 'Brand',
    privacy: 'Privacy',
    contact: 'Contact',
    languageLabel: 'Select language',
  },
  consent: {
    regionLabel: 'Cookie notice',
    heading: 'Cookie notice',
    body: 'We use analytics to see how this site is used. No ads, and no tracking across sites.',
    learnMore: 'Learn more',
    allow: 'Accept',
    decline: 'Decline',
  },
  privacy: {
    metaTitle: 'Privacy — FissionPlane',
    metaDescription:
      'How the FissionPlane website uses analytics, and how to change your choice.',
    heading: 'Privacy',
    subtitle: 'How this site uses analytics.',
    choice: {
      heading: 'Your choice',
      allowed: 'Analytics is on.',
      declined: 'Analytics is off.',
      undecided: 'You have not chosen yet. Analytics stays off until you do.',
      signalled: 'Your browser asks not to be tracked, so analytics stays off.',
      allow: 'Accept analytics',
      decline: 'Decline analytics',
    },
    sections: [
      {
        heading: 'Analytics',
        body: 'We use Cloudflare Web Analytics to count page views. It sets no cookies, stores nothing on your device, and does not track you across sites. It loads only after you accept.',
      },
      {
        heading: 'Your data',
        body: "We do not run ads, sell or share your data, or build a profile of you. Your choice is saved in your browser and never leaves your device. Clear this site's data and we will ask again.",
      },
    ],
  },
  brand: {
    metaTitle: 'FissionPlane brand guidelines',
    metaDescription:
      'Logos, wordmarks, colors, and usage rules for the FissionPlane brand. Download the assets as SVG and PNG.',
    heading: 'Brand guidelines',
    subtitle: 'Resources and assets for the FissionPlane brand.',
    downloadAll: 'Download all assets',
    assets: {
      icon: 'Icon',
      wordmark: 'Wordmark',
      lockup: 'Lockup',
      darkVariant: 'for light backgrounds',
      lightVariant: 'for dark backgrounds',
    },
    svgLabel: 'SVG',
    pngLabel: 'PNG',
    usageHeading: 'Usage',
    usageRules: [
      'Use the lockup where space allows. Use the icon at small sizes.',
      'Keep the pixel grid intact. Scale the marks in whole multiples.',
      'Do not recolor, stretch, rotate, or add effects to the marks.',
      'Keep clear space around the marks equal to the height of the icon.',
    ],
    colorsHeading: 'Colors',
    colorsIntro:
      'FissionPlane uses a warm grayscale palette. The marks use the four gray tones below.',
  },
  contact: {
    metaTitle: 'Contact — FissionPlane',
    metaDescription: 'Contact Manuel Suarez, the creator of FissionPlane.',
    heading: 'Contact',
    subtitle: 'Questions, feedback, or deployment help — get in touch.',
    directHeading: 'Reach out directly',
    directBody:
      'FissionPlane is built by Manuel Suarez. Write an email or find me here:',
    emailChannel: 'Email',
    formHeading: 'Send a message',
    formTagline: 'I read every message and reply by email.',
    emailLabel: 'Your email',
    messageLabel: 'Message',
    messageHint: 'Up to 3,000 characters.',
    submit: 'Send message',
    sending: 'Sending…',
    success: 'Message sent. I will reply soon.',
    error: 'The message did not send. Please email me directly instead.',
  },
  notFound: {
    title: 'Page not found — FissionPlane',
    heading: 'Page not found',
    body: 'This page does not exist.',
    homeLink: 'Return to the homepage.',
  },
}
