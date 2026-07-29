/**
 * Locale registry for the marketing site.
 *
 * The default locale lives at the site root; every other locale lives under
 * a `/<locale>` path prefix. `hreflang` tags and Open Graph locales map from
 * the short path prefix to the full BCP 47 / Facebook identifiers.
 */

export const DEFAULT_LOCALE = 'en'

export const LOCALES = ['en', 'es', 'de', 'fr', 'ja', 'zh'] as const

export type Locale = (typeof LOCALES)[number]

/** Native-language labels for the footer language picker. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  ja: '日本語',
  zh: '简体中文',
}

/** BCP 47 tags for `hreflang` attributes and `<html lang>`. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en',
  es: 'es',
  de: 'de',
  fr: 'fr',
  ja: 'ja',
  zh: 'zh-CN',
}

/** Open Graph `og:locale` identifiers. */
export const OG_LOCALES: Record<Locale, string> = {
  en: 'en_US',
  es: 'es_ES',
  de: 'de_DE',
  fr: 'fr_FR',
  ja: 'ja_JP',
  zh: 'zh_CN',
}

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

/**
 * Builds the site-relative URL of `pagePath` ("/", "/brand", …) in `locale`.
 * The default locale has no prefix; `trailingSlash: 'never'` keeps prefixed
 * roots at `/<locale>` with no trailing slash.
 */
export function localePath(locale: Locale, pagePath: string): string {
  if (locale === DEFAULT_LOCALE) return pagePath
  const suffix = pagePath === '/' ? '' : pagePath
  return `/${locale}${suffix}`
}
