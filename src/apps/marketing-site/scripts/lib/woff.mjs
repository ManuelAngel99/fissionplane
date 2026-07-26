/**
 * Minimal TrueType reader for the WOFF1 files shipped by
 * `@fontsource/ibm-plex-mono`.
 *
 * WOFF1 stores each sfnt table zlib-compressed and untransformed, so
 * `node:zlib` is enough to recover a plain TrueType font — no font library and
 * no system font lookup. Only what the social card needs is implemented:
 * `cmap` lookup, `hmtx` advances and `glyf` outlines.
 */

import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const WOFF_HEADER_SIZE = 44
const WOFF_ENTRY_SIZE = 20

/** @typedef {{ x: number, y: number, onCurve: boolean }} GlyphPoint */

/**
 * Expands a WOFF1 container into its sfnt tables.
 * @param {Buffer} buffer
 * @returns {Map<string, Buffer>}
 */
function decodeWoff(buffer) {
  if (buffer.toString('latin1', 0, 4) !== 'wOFF') {
    throw new Error('expected a WOFF1 container')
  }

  const numTables = buffer.readUInt16BE(12)
  const tables = new Map()

  for (let index = 0; index < numTables; index += 1) {
    const entry = WOFF_HEADER_SIZE + index * WOFF_ENTRY_SIZE
    const tag = buffer.toString('latin1', entry, entry + 4)
    const offset = buffer.readUInt32BE(entry + 4)
    const compressedLength = buffer.readUInt32BE(entry + 8)
    const originalLength = buffer.readUInt32BE(entry + 12)
    const raw = buffer.subarray(offset, offset + compressedLength)

    tables.set(tag, compressedLength < originalLength ? inflateSync(raw) : raw)
  }

  return tables
}

/**
 * @param {Map<string, Buffer>} tables
 * @param {string} tag
 * @returns {Buffer}
 */
function requireTable(tables, tag) {
  const table = tables.get(tag)
  if (!table) throw new Error(`font is missing the "${tag}" table`)
  return table
}

/**
 * Reads the best available character map into a code point → glyph id map.
 * @param {Buffer} cmap
 * @returns {Map<number, number>}
 */
function parseCmap(cmap) {
  const numTables = cmap.readUInt16BE(2)
  let bestOffset = -1
  let bestScore = -1

  for (let index = 0; index < numTables; index += 1) {
    const record = 4 + index * 8
    const platform = cmap.readUInt16BE(record)
    const encoding = cmap.readUInt16BE(record + 2)
    const offset = cmap.readUInt32BE(record + 4)
    const score =
      platform === 3 && encoding === 10
        ? 4
        : platform === 3 && encoding === 1
          ? 3
          : platform === 0
            ? 2
            : 1

    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }

  if (bestOffset < 0) throw new Error('font has no usable cmap subtable')

  const format = cmap.readUInt16BE(bestOffset)
  const map = new Map()

  if (format === 4) {
    const segCount = cmap.readUInt16BE(bestOffset + 6) / 2
    const endCodes = bestOffset + 14
    const startCodes = endCodes + segCount * 2 + 2
    const idDeltas = startCodes + segCount * 2
    const idRangeOffsets = idDeltas + segCount * 2

    for (let segment = 0; segment < segCount; segment += 1) {
      const end = cmap.readUInt16BE(endCodes + segment * 2)
      const start = cmap.readUInt16BE(startCodes + segment * 2)
      const delta = cmap.readInt16BE(idDeltas + segment * 2)
      const rangeOffsetAt = idRangeOffsets + segment * 2
      const rangeOffset = cmap.readUInt16BE(rangeOffsetAt)

      if (start === 0xffff) continue

      for (let code = start; code <= end && code !== 0x10000; code += 1) {
        let glyphId
        if (rangeOffset === 0) {
          glyphId = (code + delta) & 0xffff
        } else {
          const at = rangeOffsetAt + rangeOffset + (code - start) * 2
          if (at + 1 >= cmap.length) continue
          const raw = cmap.readUInt16BE(at)
          glyphId = raw === 0 ? 0 : (raw + delta) & 0xffff
        }
        if (glyphId !== 0) map.set(code, glyphId)
      }
    }

    return map
  }

  if (format === 12) {
    const numGroups = cmap.readUInt32BE(bestOffset + 12)
    for (let group = 0; group < numGroups; group += 1) {
      const at = bestOffset + 16 + group * 12
      const start = cmap.readUInt32BE(at)
      const end = cmap.readUInt32BE(at + 4)
      const startGlyph = cmap.readUInt32BE(at + 8)
      for (let code = start; code <= end; code += 1) {
        map.set(code, startGlyph + (code - start))
      }
    }
    return map
  }

  throw new Error(`unsupported cmap format ${format}`)
}

/**
 * Decodes one simple glyph into its contours, in font units (y up).
 * @param {Buffer} glyph
 * @param {number} numberOfContours
 * @returns {GlyphPoint[][]}
 */
function readSimpleGlyph(glyph, numberOfContours) {
  const endPoints = []
  for (let index = 0; index < numberOfContours; index += 1) {
    endPoints.push(glyph.readUInt16BE(10 + index * 2))
  }

  const pointCount = endPoints[numberOfContours - 1] + 1
  let at = 10 + numberOfContours * 2
  at += 2 + glyph.readUInt16BE(at)

  const flags = new Uint8Array(pointCount)
  for (let index = 0; index < pointCount;) {
    const flag = glyph[at]
    at += 1
    flags[index] = flag
    index += 1
    if (flag & 0x08) {
      let repeats = glyph[at]
      at += 1
      while (repeats > 0 && index < pointCount) {
        flags[index] = flag
        index += 1
        repeats -= 1
      }
    }
  }

  /**
   * Both coordinate arrays use the same delta encoding, with the "short" and
   * "same or positive" bits shifted one position apart.
   * @param {number} shortBit
   * @param {number} sameBit
   * @returns {Int32Array}
   */
  const readCoordinates = (shortBit, sameBit) => {
    const values = new Int32Array(pointCount)
    let value = 0
    for (let index = 0; index < pointCount; index += 1) {
      const flag = flags[index]
      if (flag & shortBit) {
        const delta = glyph[at]
        at += 1
        value += flag & sameBit ? delta : -delta
      } else if (!(flag & sameBit)) {
        value += glyph.readInt16BE(at)
        at += 2
      }
      values[index] = value
    }
    return values
  }

  const xs = readCoordinates(0x02, 0x10)
  const ys = readCoordinates(0x04, 0x20)

  const contours = []
  let start = 0
  for (const end of endPoints) {
    const contour = []
    for (let index = start; index <= end; index += 1) {
      contour.push({
        x: xs[index],
        y: ys[index],
        onCurve: (flags[index] & 0x01) !== 0,
      })
    }
    if (contour.length > 0) contours.push(contour)
    start = end + 1
  }

  return contours
}

/**
 * Loads a WOFF1 font and exposes the pieces the renderer needs.
 * @param {string | URL} file
 */
export function loadFont(file) {
  const tables = decodeWoff(readFileSync(file))
  const head = requireTable(tables, 'head')
  const maxp = requireTable(tables, 'maxp')
  const hhea = requireTable(tables, 'hhea')
  const hmtx = requireTable(tables, 'hmtx')
  const glyf = requireTable(tables, 'glyf')
  const locaTable = requireTable(tables, 'loca')
  const os2 = tables.get('OS/2')

  const unitsPerEm = head.readUInt16BE(18)
  const longLoca = head.readInt16BE(50) === 1
  const numGlyphs = maxp.readUInt16BE(4)
  const numberOfHMetrics = hhea.readUInt16BE(34)

  const loca = new Uint32Array(numGlyphs + 1)
  for (let index = 0; index <= numGlyphs; index += 1) {
    loca[index] = longLoca
      ? locaTable.readUInt32BE(index * 4)
      : locaTable.readUInt16BE(index * 2) * 2
  }

  const cmap = parseCmap(requireTable(tables, 'cmap'))

  // sCapHeight only exists from OS/2 version 2 onwards; fall back to the
  // ascender so vertical centring still lands somewhere sensible.
  const capHeight =
    os2 && os2.readUInt16BE(0) >= 2 ? os2.readInt16BE(88) : hhea.readInt16BE(4)

  /**
   * @param {number} glyphId
   * @param {number} depth guards against malformed composite cycles
   * @returns {GlyphPoint[][]}
   */
  const contoursOf = (glyphId, depth = 0) => {
    if (depth > 4) throw new Error('composite glyph nested too deeply')
    if (glyphId >= numGlyphs) throw new Error(`glyph ${glyphId} out of range`)

    const start = loca[glyphId]
    const end = loca[glyphId + 1]
    if (end <= start) return []

    const glyph = glyf.subarray(start, end)
    const numberOfContours = glyph.readInt16BE(0)
    if (numberOfContours >= 0) {
      return readSimpleGlyph(glyph, numberOfContours)
    }

    const contours = []
    let at = 10
    let more = true
    while (more) {
      const flags = glyph.readUInt16BE(at)
      const componentId = glyph.readUInt16BE(at + 2)
      at += 4

      let dx = 0
      let dy = 0
      if (flags & 0x0001) {
        dx = glyph.readInt16BE(at)
        dy = glyph.readInt16BE(at + 2)
        at += 4
      } else {
        dx = glyph.readInt8(at)
        dy = glyph.readInt8(at + 1)
        at += 2
      }

      let a = 1
      let b = 0
      let c = 0
      let d = 1
      const f2dot14 = (offset) => glyph.readInt16BE(offset) / 16384
      if (flags & 0x0008) {
        a = f2dot14(at)
        d = a
        at += 2
      } else if (flags & 0x0040) {
        a = f2dot14(at)
        d = f2dot14(at + 2)
        at += 4
      } else if (flags & 0x0080) {
        a = f2dot14(at)
        b = f2dot14(at + 2)
        c = f2dot14(at + 4)
        d = f2dot14(at + 6)
        at += 8
      }

      // ARGS_ARE_XY_VALUES is the only offset mode used by text fonts; point
      // matching would need the parent outline and never occurs here.
      if (!(flags & 0x0002)) throw new Error('point-matched component')

      for (const contour of contoursOf(componentId, depth + 1)) {
        contours.push(
          contour.map((point) => ({
            x: a * point.x + c * point.y + dx,
            y: b * point.x + d * point.y + dy,
            onCurve: point.onCurve,
          })),
        )
      }

      more = (flags & 0x0020) !== 0
    }

    return contours
  }

  return {
    unitsPerEm,
    capHeight,

    /** @param {number} codePoint */
    glyphId(codePoint) {
      const glyphId = cmap.get(codePoint)
      if (glyphId === undefined) {
        const hex = codePoint.toString(16).toUpperCase()
        throw new Error(`font has no glyph for U+${hex}`)
      }
      return glyphId
    },

    /** @param {number} glyphId */
    advanceOf(glyphId) {
      const index = Math.min(glyphId, numberOfHMetrics - 1)
      return hmtx.readUInt16BE(index * 4)
    },

    contoursOf,
  }
}
