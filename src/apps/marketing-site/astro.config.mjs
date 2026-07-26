// @ts-check
/** @import { AstroIntegration } from 'astro' */
import { readFile, writeFile } from 'node:fs/promises'

import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

const SITE_ORIGIN = 'https://fissionplane.dev'
const ROOT_LOC = `<loc>${SITE_ORIGIN}</loc>`
const ROOT_LOC_WITH_SLASH = `<loc>${SITE_ORIGIN}/</loc>`

/** @returns {AstroIntegration} */
function preserveRootSitemapSlash() {
  return {
    name: 'preserve-root-sitemap-slash',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const sitemapURL = new URL('sitemap-0.xml', dir)
        const sitemapXML = await readFile(sitemapURL, 'utf8')
        const rootMatches = sitemapXML.split(ROOT_LOC).length - 1

        if (rootMatches !== 1) {
          throw new Error(
            `Expected one root sitemap location, found ${rootMatches}`,
          )
        }

        await writeFile(
          sitemapURL,
          sitemapXML.replace(ROOT_LOC, ROOT_LOC_WITH_SLASH),
        )
      },
    },
  }
}

// Static site — no Cloudflare adapter needed. Wrangler uploads ./dist as assets.
// https://developers.cloudflare.com/workers/framework-guides/web-apps/astro/
export default defineConfig({
  site: SITE_ORIGIN,
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
    // @astrojs/sitemap removes the root slash whenever trailingSlash is "never",
    // after its serialize hook runs. Restore only the canonical root location.
    preserveRootSitemapSlash(),
  ],
})
