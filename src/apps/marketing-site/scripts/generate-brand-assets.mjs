#!/usr/bin/env node
/**
 * Generates `public/brand/`: the downloadable brand assets for /brand.
 *
 * From `src/assets/icon.svg` and `src/assets/lockup.svg` this script derives
 *   - light variants (the source colors, for dark backgrounds),
 *   - dark variants (mirrored grays, for light backgrounds),
 *   - a wordmark cut from the lockup,
 *   - a transparent PNG for every SVG, and
 *   - `fissionplane-brand.zip` with everything.
 *
 * The marks are axis-aligned pixel art on an integer grid, so PNGs render at
 * integer scales with an exact scanline fill — no anti-aliasing, no extra
 * dependency, no headless browser.
 *
 * Usage: pnpm --filter @fissionplane/marketing-site brand:assets
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

import { loadSvg, placeSvg } from './lib/shapes.mjs'

const BRAND_DIR = new URL('../public/brand/', import.meta.url)
mkdirSync(BRAND_DIR, { recursive: true })

// ---- SVG variants -----------------------------------------------------------

/**
 * The source marks ship light-on-dark. The dark variants mirror the gray
 * ramp so the value hierarchy survives on light backgrounds: the lightest
 * tone becomes the darkest, the mid tone stays put.
 */
const DARK_VARIANT = {
  '#F1ECEC': '#171212',
  '#B7B1B1': '#4B4646',
  '#847E7E': '#847E7E',
  '#4B4646': '#B7B1B1',
}

/** @param {string} source */
function toDarkVariant(source) {
  return source.replace(
    /#(?:F1ECEC|B7B1B1|847E7E|4B4646)/g,
    (color) => DARK_VARIANT[color],
  )
}

const iconSource = readFileSync(
  new URL('../src/assets/icon.svg', import.meta.url),
  'utf8',
)
const lockupSource = readFileSync(
  new URL('../src/assets/lockup.svg', import.meta.url),
  'utf8',
)

/** The wordmark is the lockup's second group, moved back to the origin. */
function wordmarkFromLockup(source) {
  const group = source.match(/<g transform="translate\(56 0\)">([\s\S]*?)<\/g>/)
  if (!group) throw new Error('lockup.svg is missing the wordmark group')
  return [
    '<svg width="294" height="42" viewBox="0 0 294 42" fill="none" xmlns="http://www.w3.org/2000/svg">',
    `  <g>${group[1]}</g>`,
    '</svg>',
    '',
  ].join('\n')
}

const wordmarkSource = wordmarkFromLockup(lockupSource)

/** @type {{ stem: string, source: string, scale: number }[]} */
const assets = [
  { stem: 'fissionplane-icon-light', source: iconSource, scale: 16 },
  {
    stem: 'fissionplane-icon-dark',
    source: toDarkVariant(iconSource),
    scale: 16,
  },
  { stem: 'fissionplane-wordmark-light', source: wordmarkSource, scale: 6 },
  {
    stem: 'fissionplane-wordmark-dark',
    source: toDarkVariant(wordmarkSource),
    scale: 6,
  },
  { stem: 'fissionplane-lockup-light', source: lockupSource, scale: 6 },
  {
    stem: 'fissionplane-lockup-dark',
    source: toDarkVariant(lockupSource),
    scale: 6,
  },
]

// ---- Exact RGBA rasteriser ----------------------------------------------------

/** @param {string} value */
function hexRgb(value) {
  const digits = value.replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(digits)) {
    throw new Error(`unsupported color "${value}"`)
  }
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ]
}

/**
 * Fills axis-aligned integer polygons into a transparent RGBA buffer with the
 * non-zero winding rule. One sample per pixel row is exact because every edge
 * sits on an integer coordinate after integer scaling.
 * @param {URL} file
 * @param {number} scale
 */
function rasterize(file, scale) {
  const svg = placeSvg(loadSvg(file), { x: 0, y: 0, scale })
  const width = Math.round(svg.width)
  const height = Math.round(svg.height)
  const rgba = new Uint8Array(width * height * 4)

  for (const shape of svg.shapes) {
    const [red, green, blue] = hexRgb(shape.fill)
    const edges = []
    for (const polygon of shape.polygons) {
      for (let index = 0; index < polygon.length; index += 1) {
        const [x0, y0] = polygon[index]
        const [x1, y1] = polygon[(index + 1) % polygon.length]
        if (y0 === y1) continue
        edges.push({ x0, y0, x1, y1 })
      }
    }

    for (let row = 0; row < height; row += 1) {
      const y = row + 0.5
      const crossings = []
      for (const edge of edges) {
        const from = Math.min(edge.y0, edge.y1)
        const to = Math.max(edge.y0, edge.y1)
        if (y < from || y >= to) continue
        crossings.push({
          x:
            edge.x0 +
            ((y - edge.y0) * (edge.x1 - edge.x0)) / (edge.y1 - edge.y0),
          winding: edge.y1 > edge.y0 ? 1 : -1,
        })
      }
      if (crossings.length < 2) continue
      crossings.sort((left, right) => left.x - right.x)

      let winding = 0
      let spanStart = 0
      for (const crossing of crossings) {
        if (winding === 0) spanStart = crossing.x
        winding += crossing.winding
        if (winding === 0) {
          const from = Math.max(0, Math.round(spanStart))
          const to = Math.min(width, Math.round(crossing.x))
          for (let x = from; x < to; x += 1) {
            const at = (row * width + x) * 4
            rgba[at] = red
            rgba[at + 1] = green
            rgba[at + 2] = blue
            rgba[at + 3] = 255
          }
        }
      }
    }
  }

  return pngFromRgba(rgba, width, height)
}

// ---- PNG and ZIP writers ------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
})()

/** @param {Buffer | Uint8Array} buffer */
function crc32(buffer) {
  let crc = -1
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ -1) >>> 0
}

/**
 * @param {string} type
 * @param {Buffer} data
 */
function pngChunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0)
  return Buffer.concat([header, data, crc])
}

/**
 * Truecolor-with-alpha PNG, filter 0 on every scanline. Flat pixel art
 * compresses fine without smarter filters.
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 */
function pngFromRgba(rgba, width, height) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0
    Buffer.from(rgba.buffer, row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    )
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolor with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Minimal ZIP writer, store method only. Enough for a folder of downloads;
 * the PNGs are already deflated and the SVGs are small.
 * @param {{ name: string, data: Buffer }[]} entries
 */
function zipFromEntries(entries) {
  const parts = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const crc = crc32(entry.data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x5821, 12) // date: 2024-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, name, entry.data)

    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4) // version made by
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(0, 8)
    record.writeUInt16LE(0, 10) // method: store
    record.writeUInt16LE(0, 12) // time
    record.writeUInt16LE(0x5821, 14) // date
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(entry.data.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += 30 + name.length + entry.data.length
  }

  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...parts, centralBuffer, end])
}

// ---- Write everything -----------------------------------------------------------

/** @type {{ name: string, data: Buffer }[]} */
const zipEntries = []

for (const asset of assets) {
  const svgTarget = new URL(`${asset.stem}.svg`, BRAND_DIR)
  writeFileSync(svgTarget, asset.source)
  zipEntries.push({
    name: `fissionplane-brand/${asset.stem}.svg`,
    data: Buffer.from(asset.source, 'utf8'),
  })

  const png = rasterize(svgTarget, asset.scale)
  writeFileSync(new URL(`${asset.stem}.png`, BRAND_DIR), png)
  zipEntries.push({ name: `fissionplane-brand/${asset.stem}.png`, data: png })

  process.stdout.write(
    `${asset.stem}: svg ${(asset.source.length / 1024).toFixed(1)} kB, ` +
      `png ${(png.length / 1024).toFixed(1)} kB\n`,
  )
}

const zip = zipFromEntries(zipEntries)
writeFileSync(new URL('fissionplane-brand.zip', BRAND_DIR), zip)
process.stdout.write(
  `fissionplane-brand.zip — ${zipEntries.length} files, ` +
    `${(zip.length / 1024).toFixed(1)} kB\n`,
)
