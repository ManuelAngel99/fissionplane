/**
 * Shape of one locale's copy. Every locale file exports a complete
 * `Dictionary`, so a missing translation is a type error, not a blank spot
 * on the page.
 */

export interface FaqItem {
  question: string
  answer: string
}

export interface WorkloadCard {
  title: string
  tagline: string
  bullets: string[]
}

export interface UseCase {
  title: string
  body: string
}

export interface WhatBullet {
  strong: string
  text: string
}

export interface BrandAssetLabels {
  icon: string
  wordmark: string
  lockup: string
  darkVariant: string
  lightVariant: string
}

/** A privacy-page section: one heading over one paragraph. */
export interface PrivacySection {
  heading: string
  body: string
}

/**
 * The live consent control on the privacy page. Which status line shows is
 * decided in the browser, so all four ship on every page.
 */
export interface PrivacyChoice {
  heading: string
  /** Analytics allowed. */
  allowed: string
  /** Analytics declined. */
  declined: string
  /** No answer given yet. */
  undecided: string
  /** Browser sends Global Privacy Control or Do Not Track; overrides the rest. */
  signalled: string
  allow: string
  decline: string
}

export interface Dictionary {
  meta: {
    title: string
    description: string
    imageAlt: string
  }
  nav: {
    contact: string
    github: string
    githubTitle: string
    docs: string
    docsTitle: string
    homeAriaLabel: string
  }
  hero: {
    heading: string
    body: string
  }
  /** Left hero column: the deploy-anywhere visual. */
  platform: {
    heading: string
    tagline: string
    /** Line under the logo grid for the long tail of deploy targets. */
    note: string
  }
  /** Right hero column: connect an SDK. */
  install: {
    heading: string
    tagline: string
    groupLabel: string
    copyLabel: string
    copiedLabel: string
    /** Tooltip and accessible label of the copy-code button. */
    copyCode: string
    /** Text before the agent link, e.g. "Or". */
    agentPrefix: string
    /** Clickable text that copies the SDK-builder prompt. */
    agentLink: string
    /** Toast shown after the prompt lands on the clipboard. */
    copiedToast: string
  }
  workloads: {
    heading: string
    intro: string
    sandboxes: WorkloadCard
    functions: WorkloadCard
  }
  architecture: {
    heading: string
    body: string
    diagramLabel: string
  }
  useCases: {
    heading: string
    items: UseCase[]
  }
  what: {
    heading: string
    body: string
    bullets: WhatBullet[]
    link: string
  }
  faq: {
    heading: string
    items: FaqItem[]
  }
  cta: {
    heading: string
    body: string
    link: string
  }
  footer: {
    github: string
    docs: string
    changelog: string
    license: string
    brand: string
    privacy: string
    contact: string
    languageLabel: string
  }
  /** The cookie banner. Shown once, before the analytics beacon may load. */
  consent: {
    regionLabel: string
    heading: string
    body: string
    privacyLink: string
    allow: string
    decline: string
  }
  privacy: {
    metaTitle: string
    metaDescription: string
    heading: string
    subtitle: string
    choice: PrivacyChoice
    sections: PrivacySection[]
  }
  brand: {
    metaTitle: string
    metaDescription: string
    heading: string
    subtitle: string
    downloadAll: string
    assets: BrandAssetLabels
    svgLabel: string
    pngLabel: string
    usageHeading: string
    usageRules: string[]
    colorsHeading: string
    colorsIntro: string
  }
  contact: {
    metaTitle: string
    metaDescription: string
    heading: string
    subtitle: string
    /** Direct-contact block: intro line above the email and social links. */
    directHeading: string
    directBody: string
    /** Row label for the email address in the channel list. */
    emailChannel: string
    formHeading: string
    /** One-line tagline under the form heading; balances the left column. */
    formTagline: string
    emailLabel: string
    messageLabel: string
    /** Character-limit hint under the message field. */
    messageHint: string
    submit: string
    /** Button label while the message is in flight. */
    sending: string
    success: string
    error: string
  }
  notFound: {
    title: string
    heading: string
    body: string
    homeLink: string
  }
}
