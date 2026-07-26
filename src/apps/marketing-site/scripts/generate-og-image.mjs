#!/usr/bin/env node
/**
 * Renders `public/og-image.png`, the 1200x630 social card.
 *
 * The card is drawn from the project's own assets so it cannot drift from the
 * site: the FissionPlane lockup comes from `src/assets/lockup.svg`, every
 * glyph comes from the IBM Plex Mono WOFF files installed by
 * `@fontsource/ibm-plex-mono`, and the palette is the dark-scheme token set in
 * `src/styles/global.css`. Nothing here needs a headless browser, a system
 * font or an extra dependency.
 *
 * Usage: pnpm --filter @fissionplane/marketing-site og:image
 */

import { writeFileSync } from 'node:fs'

import { Canvas } from './lib/raster.mjs'
import {
  frame,
  gridUnitOf,
  loadSvg,
  placeSvg,
  rectangle,
  roundedRectangle,
  textPolygons,
  textWidth,
} from './lib/shapes.mjs'
import { loadFont } from './lib/woff.mjs'

/** @typedef {[number, number, number]} Rgb */

/**
 * CSS `hsl()` with integer percentages, matching how the browser resolves the
 * custom properties in global.css.
 * @param {number} hue
 * @param {number} saturation
 * @param {number} lightness
 * @returns {Rgb}
 */
function hsl(hue, saturation, lightness) {
  const s = saturation / 100
  const l = lightness / 100
  const chroma = (1 - Math.abs(2 * l - 1)) * s
  const sector = (((hue % 360) + 360) % 360) / 60
  const second = chroma * (1 - Math.abs((sector % 2) - 1))
  const [r, g, b] =
    sector < 1
      ? [chroma, second, 0]
      : sector < 2
        ? [second, chroma, 0]
        : sector < 3
          ? [0, chroma, second]
          : sector < 4
            ? [0, second, chroma]
            : sector < 5
              ? [second, 0, chroma]
              : [chroma, 0, second]
  const match = l - chroma / 2
  return [
    Math.round((r + match) * 255),
    Math.round((g + match) * 255),
    Math.round((b + match) * 255),
  ]
}

/**
 * @param {string} value `#rgb` or `#rrggbb`
 * @returns {Rgb}
 */
function hex(value) {
  const digits = value.replace('#', '')
  const full =
    digits.length === 3
      ? digits
          .split('')
          .map((digit) => digit + digit)
          .join('')
      : digits
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`unsupported colour "${value}"`)
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

/**
 * Dark-scheme tokens from `src/styles/global.css`. The card always uses the
 * dark scheme: the lockup ships light-on-dark, and dark cards read better in
 * both light and dark social clients.
 */
const COLOR = {
  background: hsl(0, 9, 7),
  backgroundWeak: hsl(0, 6, 10),
  borderWeak: hsl(0, 4, 23),
  text: hsl(0, 4, 71),
  textStrong: hsl(0, 15, 94),
}

const CARD = { width: 1200, height: 630 }

/** Border inset, well inside the crop social clients may apply. */
const FRAME = { inset: 40, thickness: 2 }

/** Content column, mirroring the landing page's framed container padding. */
const CONTENT = { left: 104, right: CARD.width - 104 }
const CONTENT_WIDTH = CONTENT.right - CONTENT.left

/**
 * `lockupScale` is 1.5 rather than a target height: the mark is pixel art on a
 * 2-unit grid, so 2 x 1.5 = 3 whole device pixels per art pixel keeps every
 * edge hard. Non-integer scales would smear the atom into grey mush.
 */
const HEADER = { height: 128, lockupScale: 1.5, siteSize: 20 }
const HEADLINE = { size: 52, baselines: [262, 332] }
const SUBTITLE = { size: 21, baselines: [390, 427] }
const CHIP = { y: 474, height: 60, radius: 6, padding: 22, size: 20 }
const META = { size: 17 }

const COPY = {
  site: 'fissionplane.dev',
  headline: ['Self-hosted sandboxes and', 'serverless functions'],
  subtitle: [
    'Run AI-generated and untrusted code in isolated Firecracker',
    'microVMs on infrastructure you operate. Open source, Apache-2.0.',
  ],
  install: { prefix: 'npm install ', package: '@fissionplane/sdk' },
  meta: 'TypeScript · Python · Rust',
}

/** @param {'400' | '500' | '700'} weight */
function fontFile(weight) {
  return new URL(
    import.meta.resolve(
      `@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-${weight}-normal.woff`,
    ),
  )
}

const regular = loadFont(fontFile('400'))
const medium = loadFont(fontFile('500'))
const bold = loadFont(fontFile('700'))

const canvas = new Canvas(CARD.width, CARD.height, COLOR.background)

/**
 * Baseline that vertically centres capital letters on `middle`.
 * @param {ReturnType<typeof loadFont>} font
 * @param {number} size
 * @param {number} middle
 */
function centredBaseline(font, size, middle) {
  return middle + (font.capHeight * size) / font.unitsPerEm / 2
}

/**
 * Draws one line of text, refusing to render anything that would overflow the
 * content column and get clipped.
 * @param {ReturnType<typeof loadFont>} font
 * @param {string} text
 * @param {{ size: number, x: number, baseline: number, color: Rgb }} options
 * @returns {number} the x position just past the text
 */
function drawText(font, text, { size, x, baseline, color }) {
  const width = textWidth(font, text, size)
  if (x < CONTENT.left - 0.5 || x + width > CONTENT.right + 0.5) {
    throw new Error(
      `"${text}" (${width.toFixed(1)}px at x=${x.toFixed(1)}) ` +
        `does not fit the ${CONTENT_WIDTH}px content column`,
    )
  }
  canvas.paint(textPolygons(font, text, { size, x, baseline }), color)
  return x + width
}

// ---- Frame and header rule -------------------------------------------------

canvas.paint(
  frame(
    {
      x: FRAME.inset,
      y: FRAME.inset,
      width: CARD.width - FRAME.inset * 2,
      height: CARD.height - FRAME.inset * 2,
    },
    FRAME.thickness,
  ),
  COLOR.borderWeak,
)

const headerBottom = FRAME.inset + HEADER.height
canvas.paint(
  [
    rectangle({
      x: FRAME.inset,
      y: headerBottom - FRAME.thickness,
      width: CARD.width - FRAME.inset * 2,
      height: FRAME.thickness,
    }),
  ],
  COLOR.borderWeak,
)

// ---- Brand lockup ----------------------------------------------------------

const lockup = loadSvg(new URL('../src/assets/lockup.svg', import.meta.url))
const gridUnit = gridUnitOf(lockup)
if (!Number.isInteger(gridUnit * HEADER.lockupScale)) {
  throw new Error(
    `scale ${HEADER.lockupScale} blurs the lockup's ${gridUnit}-unit grid`,
  )
}

const headerMiddle = FRAME.inset + (HEADER.height - FRAME.thickness) / 2
const placedLockup = placeSvg(lockup, {
  x: CONTENT.left,
  // Rounded so art pixels start on a device pixel boundary.
  y: Math.round(headerMiddle - (lockup.height * HEADER.lockupScale) / 2),
  scale: HEADER.lockupScale,
})

if (CONTENT.left + placedLockup.width > CONTENT.right) {
  throw new Error('lockup does not fit the content column')
}

for (const shape of placedLockup.shapes) {
  canvas.paint(shape.polygons, hex(shape.fill))
}

// ---- Header URL ------------------------------------------------------------

drawText(regular, COPY.site, {
  size: HEADER.siteSize,
  x: CONTENT.right - textWidth(regular, COPY.site, HEADER.siteSize),
  baseline: centredBaseline(regular, HEADER.siteSize, headerMiddle),
  color: COLOR.textStrong,
})

// ---- Headline and subtitle -------------------------------------------------

COPY.headline.forEach((line, index) => {
  drawText(bold, line, {
    size: HEADLINE.size,
    x: CONTENT.left,
    baseline: HEADLINE.baselines[index],
    color: COLOR.textStrong,
  })
})

COPY.subtitle.forEach((line, index) => {
  drawText(regular, line, {
    size: SUBTITLE.size,
    x: CONTENT.left,
    baseline: SUBTITLE.baselines[index],
    color: COLOR.text,
  })
})

// ---- Install chip, mirroring the landing page's install panel ---------------

const installWidth =
  textWidth(regular, COPY.install.prefix, CHIP.size) +
  textWidth(medium, COPY.install.package, CHIP.size)
const chip = {
  x: CONTENT.left,
  y: CHIP.y,
  width: installWidth + CHIP.padding * 2,
  height: CHIP.height,
}

canvas.paint([roundedRectangle(chip, CHIP.radius)], COLOR.backgroundWeak)
canvas.paint(
  [
    roundedRectangle(chip, CHIP.radius),
    roundedRectangle(
      {
        x: chip.x + FRAME.thickness / 2,
        y: chip.y + FRAME.thickness / 2,
        width: chip.width - FRAME.thickness,
        height: chip.height - FRAME.thickness,
      },
      CHIP.radius - FRAME.thickness / 2,
    ).toReversed(),
  ],
  COLOR.borderWeak,
)

const chipMiddle = chip.y + chip.height / 2
const afterPrefix = drawText(regular, COPY.install.prefix, {
  size: CHIP.size,
  x: chip.x + CHIP.padding,
  baseline: centredBaseline(regular, CHIP.size, chipMiddle),
  color: COLOR.text,
})

drawText(medium, COPY.install.package, {
  size: CHIP.size,
  x: afterPrefix,
  baseline: centredBaseline(medium, CHIP.size, chipMiddle),
  color: COLOR.textStrong,
})

// ---- Supported SDKs --------------------------------------------------------

drawText(regular, COPY.meta, {
  size: META.size,
  x: CONTENT.right - textWidth(regular, COPY.meta, META.size),
  baseline: centredBaseline(regular, META.size, chipMiddle),
  color: COLOR.text,
})

// ---- Write -----------------------------------------------------------------

const target = new URL('../public/og-image.png', import.meta.url)
const png = canvas.toPng()
writeFileSync(target, png)

const kilobytes = (png.length / 1024).toFixed(1)
process.stdout.write(
  `og-image.png — ${CARD.width}x${CARD.height}, ${kilobytes} kB\n`,
)
