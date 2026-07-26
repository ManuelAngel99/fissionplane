// @ts-check
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

// Static site — no Cloudflare adapter needed. Wrangler uploads ./dist as assets.
// https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/
export default defineConfig({
  site: 'https://fissionplane.dev',
  output: 'static',
  trailingSlash: 'never',
  integrations: [
    sitemap({
      // Indexable marketing URLs only — exclude the custom 404 document.
      filter: (page) => !page.includes('/404'),
      changefreq: 'weekly',
      priority: 1,
      // Emits xhtml:link hreflang alternates for the /<locale>/ page tree.
      i18n: {
        defaultLocale: 'en',
        locales: {
          en: 'en',
          es: 'es',
          de: 'de',
          fr: 'fr',
          ja: 'ja',
          zh: 'zh-CN',
        },
      },
    }),
  ],
})
