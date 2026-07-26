/**
 * Anti-aliased polygon rasteriser and PNG writer.
 *
 * Shapes arrive as flattened closed polygons in device pixels. Coverage is
 * sampled on `SUBSAMPLES` horizontal scanlines per pixel row, and horizontal
 * coverage inside a row is computed exactly from the span endpoints, so edges
 * stay smooth without rendering at a larger size first.
 */

import { deflateSync } from 'node:zlib'

const SUBSAMPLES = 16

/** @typedef {[number, number]} Point */
/** @typedef {Point[]} Polygon */

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

/** @param {Buffer} buffer */
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
 * Picks the cheapest of the None/Sub/Up filters per row, which is where nearly
 * all of the win is for flat artwork with anti-aliased edges.
 * @param {Uint8ClampedArray} rgb
 * @param {number} width
 * @param {number} height
 */
function filterScanlines(rgb, width, height) {
  const stride = width * 3
  const out = Buffer.alloc((stride + 1) * height)

  const none = Buffer.alloc(stride)
  const sub = Buffer.alloc(stride)
  const up = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const row = y * stride
    let noneScore = 0
    let subScore = 0
    let upScore = 0

    for (let index = 0; index < stride; index += 1) {
      const raw = rgb[row + index]
      const left = index >= 3 ? rgb[row + index - 3] : 0
      const above = y > 0 ? rgb[row - stride + index] : 0

      none[index] = raw
      sub[index] = (raw - left) & 0xff
      up[index] = (raw - above) & 0xff

      noneScore += raw < 128 ? raw : 256 - raw
      subScore += sub[index] < 128 ? sub[index] : 256 - sub[index]
      upScore += up[index] < 128 ? up[index] : 256 - up[index]
    }

    const best =
      subScore <= noneScore && subScore <= upScore
        ? { type: 1, data: sub }
        : upScore <= noneScore
          ? { type: 2, data: up }
          : { type: 0, data: none }

    out[y * (stride + 1)] = best.type
    best.data.copy(out, y * (stride + 1) + 1)
  }

  return out
}

export class Canvas {
  /**
   * @param {number} width
   * @param {number} height
   * @param {[number, number, number]} background
   */
  constructor(width, height, background) {
    this.width = width
    this.height = height
    // Clamped so blending rounds to nearest instead of truncating.
    this.pixels = new Uint8ClampedArray(width * height * 3)
    for (let index = 0; index < this.pixels.length; index += 3) {
      this.pixels[index] = background[0]
      this.pixels[index + 1] = background[1]
      this.pixels[index + 2] = background[2]
    }
  }

  /**
   * Fills polygons with the non-zero winding rule.
   * @param {Polygon[]} polygons
   * @param {[number, number, number]} color
   */
  paint(polygons, color) {
    /** @type {{ x0: number, y0: number, x1: number, y1: number }[]} */
    const edges = []
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    for (const polygon of polygons) {
      for (let index = 0; index < polygon.length; index += 1) {
        const [x0, y0] = polygon[index]
        const [x1, y1] = polygon[(index + 1) % polygon.length]
        if (y0 === y1) continue
        edges.push({ x0, y0, x1, y1 })
        minX = Math.min(minX, x0, x1)
        maxX = Math.max(maxX, x0, x1)
        minY = Math.min(minY, y0, y1)
        maxY = Math.max(maxY, y0, y1)
      }
    }

    if (edges.length === 0) return

    const rowFrom = Math.max(0, Math.floor(minY))
    const rowTo = Math.min(this.height - 1, Math.ceil(maxY))
    const colFrom = Math.max(0, Math.floor(minX))
    const colTo = Math.min(this.width - 1, Math.ceil(maxX))
    if (rowFrom > rowTo || colFrom > colTo) return

    // Bucket edges by pixel row so each scanline only visits nearby geometry.
    /** @type {number[][]} */
    const buckets = Array.from({ length: rowTo - rowFrom + 1 }, () => [])
    for (let index = 0; index < edges.length; index += 1) {
      const { y0, y1 } = edges[index]
      const from = Math.max(rowFrom, Math.floor(Math.min(y0, y1)))
      const to = Math.min(rowTo, Math.ceil(Math.max(y0, y1)))
      for (let row = from; row <= to; row += 1) {
        buckets[row - rowFrom].push(index)
      }
    }

    const columns = colTo - colFrom + 1
    const coverage = new Float64Array(columns)
    /** @type {{ x: number, winding: number }[]} */
    const crossings = []
    const weight = 1 / SUBSAMPLES
    const [red, green, blue] = color

    for (let row = rowFrom; row <= rowTo; row += 1) {
      const bucket = buckets[row - rowFrom]
      if (bucket.length === 0) continue
      coverage.fill(0)

      for (let sample = 0; sample < SUBSAMPLES; sample += 1) {
        const y = row + (sample + 0.5) / SUBSAMPLES
        crossings.length = 0

        for (const index of bucket) {
          const { x0, y0, x1, y1 } = edges[index]
          const from = Math.min(y0, y1)
          const to = Math.max(y0, y1)
          if (y < from || y >= to) continue
          crossings.push({
            x: x0 + ((y - y0) * (x1 - x0)) / (y1 - y0),
            winding: y1 > y0 ? 1 : -1,
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
            this.#addSpan(
              coverage,
              spanStart - colFrom,
              crossing.x - colFrom,
              weight,
              columns,
            )
          }
        }
      }

      const rowOffset = (row * this.width + colFrom) * 3
      for (let column = 0; column < columns; column += 1) {
        const alpha = coverage[column]
        if (alpha <= 0.0005) continue
        const clamped = alpha >= 1 ? 1 : alpha
        const at = rowOffset + column * 3
        const pixels = this.pixels
        pixels[at] = pixels[at] + (red - pixels[at]) * clamped
        pixels[at + 1] = pixels[at + 1] + (green - pixels[at + 1]) * clamped
        pixels[at + 2] = pixels[at + 2] + (blue - pixels[at + 2]) * clamped
      }
    }
  }

  /**
   * Adds one horizontal span, weighting the two partially covered end pixels
   * by how much of them the span actually crosses.
   * @param {Float64Array} coverage
   * @param {number} from
   * @param {number} to
   * @param {number} weight
   * @param {number} columns
   */
  #addSpan(coverage, from, to, weight, columns) {
    const start = Math.max(0, from)
    const end = Math.min(columns, to)
    if (end <= start) return

    const first = Math.floor(start)
    const last = Math.min(columns - 1, Math.floor(end - 1e-9))

    if (first === last) {
      coverage[first] += (end - start) * weight
      return
    }

    coverage[first] += (first + 1 - start) * weight
    for (let column = first + 1; column < last; column += 1) {
      coverage[column] += weight
    }
    coverage[last] += (end - last) * weight
  }

  toPng() {
    const raw = filterScanlines(this.pixels, this.width, this.height)
    const header = Buffer.alloc(13)
    header.writeUInt32BE(this.width, 0)
    header.writeUInt32BE(this.height, 4)
    header[8] = 8 // bit depth
    header[9] = 2 // truecolour, no alpha
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(raw, { level: 9 })),
      pngChunk('IEND', Buffer.alloc(0)),
    ])
  }
}
