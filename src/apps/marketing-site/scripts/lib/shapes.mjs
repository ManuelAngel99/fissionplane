/**
 * Turns brand assets into flattened polygons for the rasteriser: the axis
 * aligned paths of the FissionPlane lockup, and IBM Plex Mono glyph outlines.
 */

import { readFileSync } from 'node:fs'

/** Maximum distance in device pixels between a curve and its polyline. */
const CURVE_TOLERANCE = 0.2

/** @typedef {[number, number]} Point */
/** @typedef {Point[]} Polygon */
/** @typedef {{ polygons: Polygon[], fill: string }} SvgShape */

const NODE = /<g\b[^>]*>|<\/g>|<path\b[^>]*\/>/g
const TRANSLATE = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/
const ATTRIBUTE = /(\w[\w-]*)="([^"]*)"/g
const PATH_TOKEN = /[MLHVZmlhvz]|-?\d*\.?\d+(?:e-?\d+)?/g

/**
 * Parses the subset of SVG path syntax the brand marks use: absolute and
 * relative move/line/horizontal/vertical/close. Anything else throws rather
 * than being silently dropped.
 * @param {string} definition
 * @returns {Polygon[]}
 */
function parsePathData(definition) {
  const tokens = definition.match(PATH_TOKEN) ?? []
  /** @type {Polygon[]} */
  const polygons = []
  /** @type {Polygon | null} */
  let current = null
  let command = ''
  let x = 0
  let y = 0
  let index = 0

  const number = () => {
    const token = tokens[index]
    index += 1
    const value = Number(token)
    if (!Number.isFinite(value)) {
      throw new Error(`unexpected token "${token}" in path data`)
    }
    return value
  }

  const close = () => {
    if (current && current.length > 1) polygons.push(current)
    current = null
  }

  while (index < tokens.length) {
    const token = tokens[index]
    if (/[A-Za-z]/.test(token)) {
      command = token
      index += 1
      if (command === 'Z' || command === 'z') {
        close()
        continue
      }
    } else if (command === 'M') {
      command = 'L'
    } else if (command === 'm') {
      command = 'l'
    }

    switch (command) {
      case 'M':
      case 'm': {
        close()
        const dx = number()
        const dy = number()
        x = command === 'M' ? dx : x + dx
        y = command === 'M' ? dy : y + dy
        current = [[x, y]]
        break
      }
      case 'L':
      case 'l': {
        const dx = number()
        const dy = number()
        x = command === 'L' ? dx : x + dx
        y = command === 'L' ? dy : y + dy
        current?.push([x, y])
        break
      }
      case 'H':
      case 'h': {
        const dx = number()
        x = command === 'H' ? dx : x + dx
        current?.push([x, y])
        break
      }
      case 'V':
      case 'v': {
        const dy = number()
        y = command === 'V' ? dy : y + dy
        current?.push([x, y])
        break
      }
      default:
        throw new Error(`unsupported path command "${command}"`)
    }
  }

  close()
  return polygons
}

/** @param {string} tag */
function attributesOf(tag) {
  /** @type {Record<string, string>} */
  const attributes = {}
  for (const match of tag.matchAll(ATTRIBUTE)) {
    attributes[match[1]] = match[2]
  }
  return attributes
}

/**
 * Reads an SVG made of `<g transform="translate(…)">` groups wrapping filled
 * `<path>` elements — the shape of the FissionPlane lockup and icon.
 * @param {string | URL} file
 * @returns {{ width: number, height: number, shapes: SvgShape[] }}
 */
export function loadSvg(file) {
  const source = readFileSync(file, 'utf8')
  const root = source.match(/<svg\b[^>]*>/)
  if (!root) throw new Error('file is not an SVG')

  const rootAttributes = attributesOf(root[0])
  const viewBox = (rootAttributes.viewBox ?? '').split(/[\s,]+/).map(Number)
  if (viewBox.length !== 4) throw new Error('SVG needs a viewBox')

  /** @type {SvgShape[]} */
  const shapes = []
  /** @type {Point[]} */
  const stack = [[0, 0]]

  for (const match of source.matchAll(NODE)) {
    const tag = match[0]

    if (tag === '</g>') {
      if (stack.length === 1) throw new Error('unbalanced </g>')
      stack.pop()
      continue
    }

    const [offsetX, offsetY] = stack[stack.length - 1]

    if (tag.startsWith('<g')) {
      const transform = attributesOf(tag).transform ?? ''
      if (transform && !TRANSLATE.test(transform)) {
        throw new Error(`unsupported group transform "${transform}"`)
      }
      const translate = transform.match(TRANSLATE)
      stack.push(
        translate
          ? [offsetX + Number(translate[1]), offsetY + Number(translate[2])]
          : [offsetX, offsetY],
      )
      continue
    }

    const { d, fill } = attributesOf(tag)
    if (!d) throw new Error('path is missing "d"')
    if (!fill || fill === 'none') throw new Error('path is missing a fill')

    shapes.push({
      fill,
      polygons: parsePathData(d).map((polygon) =>
        polygon.map(([px, py]) => [px + offsetX, py + offsetY]),
      ),
    })
  }

  if (stack.length !== 1) throw new Error('unbalanced <g>')

  return { width: viewBox[2], height: viewBox[3], shapes }
}

/**
 * Places an SVG's shapes at a uniform scale.
 *
 * The brand marks are pixel art on an even-unit grid, so an integer origin
 * plus a scale that keeps `gridUnit * scale` whole puts every edge exactly on
 * a pixel boundary — no anti-aliasing, no soft edges.
 * @param {{ width: number, height: number, shapes: SvgShape[] }} svg
 * @param {{ x: number, y: number, scale: number }} placement
 * @returns {{ width: number, height: number, shapes: SvgShape[] }}
 */
export function placeSvg(svg, { x, y, scale }) {
  return {
    width: svg.width * scale,
    height: svg.height * scale,
    shapes: svg.shapes.map((shape) => ({
      fill: shape.fill,
      polygons: shape.polygons.map((polygon) =>
        polygon.map(([px, py]) => [x + px * scale, y + py * scale]),
      ),
    })),
  }
}

/**
 * @param {number} a
 * @param {number} b
 */
function gcd(a, b) {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

/**
 * Largest grid unit every coordinate in an SVG sits on. Used to check that a
 * placement scale keeps pixel art aligned to whole device pixels.
 * @param {{ shapes: SvgShape[] }} svg
 */
export function gridUnitOf(svg) {
  let unit = 0
  for (const shape of svg.shapes) {
    for (const polygon of shape.polygons) {
      for (const point of polygon) {
        for (const value of point) {
          if (!Number.isInteger(value)) return 1
          unit = gcd(unit, Math.abs(value))
        }
      }
    }
  }
  return unit || 1
}

/**
 * Flattens one quadratic segment, subdividing based on how far the control
 * point pulls the curve away from a straight line.
 * @param {Polygon} out
 * @param {Point} from
 * @param {Point} control
 * @param {Point} to
 */
function quadraticTo(out, from, control, to) {
  const span =
    Math.hypot(control[0] - from[0], control[1] - from[1]) +
    Math.hypot(to[0] - control[0], to[1] - control[1])
  const steps = Math.min(64, Math.max(2, Math.ceil(span / CURVE_TOLERANCE)))

  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps
    const s = 1 - t
    out.push([
      s * s * from[0] + 2 * s * t * control[0] + t * t * to[0],
      s * s * from[1] + 2 * s * t * control[1] + t * t * to[1],
    ])
  }
}

/**
 * Converts one TrueType contour — a mix of on- and off-curve points, with
 * implied on-curve midpoints between consecutive control points — into a
 * closed polyline in device space.
 * @param {{ x: number, y: number, onCurve: boolean }[]} contour
 * @param {(x: number, y: number) => Point} project
 * @returns {Polygon}
 */
function contourToPolygon(contour, project) {
  /** @type {Point[]} */
  const points = contour.map((point) => project(point.x, point.y))
  const onCurve = contour.map((point) => point.onCurve)
  const count = points.length

  /** @type {Point} */
  let start
  let first
  if (onCurve[0]) {
    start = points[0]
    first = 1
  } else if (onCurve[count - 1]) {
    start = points[count - 1]
    first = 0
  } else {
    start = [
      (points[0][0] + points[count - 1][0]) / 2,
      (points[0][1] + points[count - 1][1]) / 2,
    ]
    first = 0
  }

  /** @type {Polygon} */
  const polygon = [start]
  let cursor = start
  /** @type {Point | null} */
  let control = null

  for (let step = 0; step < count; step += 1) {
    const index = (first + step) % count
    const point = points[index]

    if (onCurve[index]) {
      if (control) {
        quadraticTo(polygon, cursor, control, point)
        control = null
      } else {
        polygon.push(point)
      }
      cursor = point
      continue
    }

    if (control) {
      /** @type {Point} */
      const midpoint = [
        (control[0] + point[0]) / 2,
        (control[1] + point[1]) / 2,
      ]
      quadraticTo(polygon, cursor, control, midpoint)
      cursor = midpoint
    }
    control = point
  }

  if (control) quadraticTo(polygon, cursor, control, start)
  return polygon
}

/**
 * Lays out a single line of text and returns its outlines as polygons.
 * @param {ReturnType<import('./woff.mjs').loadFont>} font
 * @param {string} text
 * @param {{ size: number, x: number, baseline: number }} placement
 * @returns {Polygon[]}
 */
export function textPolygons(font, text, { size, x, baseline }) {
  const scale = size / font.unitsPerEm
  /** @type {Polygon[]} */
  const polygons = []
  let penX = x

  for (const character of text) {
    const glyphId = font.glyphId(character.codePointAt(0) ?? 0)
    const origin = penX
    /** @type {(gx: number, gy: number) => Point} */
    const project = (gx, gy) => [origin + gx * scale, baseline - gy * scale]

    for (const contour of font.contoursOf(glyphId)) {
      if (contour.length > 1) polygons.push(contourToPolygon(contour, project))
    }

    penX += font.advanceOf(glyphId) * scale
  }

  return polygons
}

/**
 * Advance width of a string, for centring and for sizing containers.
 * @param {ReturnType<import('./woff.mjs').loadFont>} font
 * @param {string} text
 * @param {number} size
 */
export function textWidth(font, text, size) {
  let width = 0
  for (const character of text) {
    width += font.advanceOf(font.glyphId(character.codePointAt(0) ?? 0))
  }
  return (width * size) / font.unitsPerEm
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @returns {Polygon}
 */
export function rectangle({ x, y, width, height }) {
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ]
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {number} radius
 * @returns {Polygon}
 */
export function roundedRectangle({ x, y, width, height }, radius) {
  const r = Math.min(radius, width / 2, height / 2)
  if (r <= 0) return rectangle({ x, y, width, height })

  const steps = Math.max(4, Math.ceil(r))
  /** @type {Polygon} */
  const polygon = []
  const corners = [
    { cx: x + width - r, cy: y + r, from: -Math.PI / 2 },
    { cx: x + width - r, cy: y + height - r, from: 0 },
    { cx: x + r, cy: y + height - r, from: Math.PI / 2 },
    { cx: x + r, cy: y + r, from: Math.PI },
  ]

  for (const { cx, cy, from } of corners) {
    for (let step = 0; step <= steps; step += 1) {
      const angle = from + (step / steps) * (Math.PI / 2)
      polygon.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)])
    }
  }

  return polygon
}

/**
 * A hairline frame drawn as four rectangles, so the stroke stays exactly on
 * the pixel grid instead of straddling it.
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {number} thickness
 * @returns {Polygon[]}
 */
export function frame({ x, y, width, height }, thickness) {
  return [
    rectangle({ x, y, width, height: thickness }),
    rectangle({ x, y: y + height - thickness, width, height: thickness }),
    rectangle({
      x,
      y: y + thickness,
      width: thickness,
      height: height - thickness * 2,
    }),
    rectangle({
      x: x + width - thickness,
      y: y + thickness,
      width: thickness,
      height: height - thickness * 2,
    }),
  ]
}
