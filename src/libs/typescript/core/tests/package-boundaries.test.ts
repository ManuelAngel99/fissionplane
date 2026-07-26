import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return sourceFiles(path)
    }
    return entry.name.endsWith('.ts') ? [path] : []
  })

/** Matches single-line and multi-line `import`/`export … from '…'` clauses. */
const IMPORT_PATTERN = /\bfrom\s+'([^']+)'/gu

const byName = (left: string, right: string) => left.localeCompare(right)

const modules = sourceFiles(sourceRoot).map((path) => {
  const contents = readFileSync(path, 'utf8')
  return {
    contents,
    imports: [...contents.matchAll(IMPORT_PATTERN)].flatMap(
      (match) => match[1] ?? [],
    ),
    specifier: `@fissionplane/core/${relative(sourceRoot, path).replace(/\.ts$/u, '')}`,
  }
})

const importGraph = new Map(
  modules.map((module) => [
    module.specifier,
    module.imports.filter((specifier) =>
      specifier.startsWith('@fissionplane/core/'),
    ),
  ]),
)

/** Depth-first walk returning the first cycle it can reach from `start`. */
const findCycle = (start: string): ReadonlyArray<string> | undefined => {
  const walk = (
    specifier: string,
    path: ReadonlyArray<string>,
  ): ReadonlyArray<string> | undefined => {
    if (path.includes(specifier)) {
      return [...path.slice(path.indexOf(specifier)), specifier]
    }
    for (const dependency of importGraph.get(specifier) ?? []) {
      const cycle = walk(dependency, [...path, specifier])
      if (cycle !== undefined) {
        return cycle
      }
    }
    return undefined
  }
  return walk(start, [])
}

describe('client-safe package boundary', () => {
  it('covers every shipped module', () => {
    expect(modules.length).toBeGreaterThan(0)
  })

  it.each(modules)('$specifier stays browser safe', ({ contents }) => {
    expect(contents).not.toMatch(
      /from '@fissionplane\/(api|db|[a-z]+-(api|web))/u,
    )
    expect(contents).not.toMatch(/from 'node:/u)
    expect(contents).not.toMatch(/\bprocess\.env\b/u)
    expect(contents).not.toMatch(/\bbetter-auth'/u)
    expect(contents).not.toMatch(/better-auth\/(?!plugins\/access')/u)
  })

  it.each(modules)(
    '$specifier imports absolutely and narrowly',
    ({ imports }) => {
      for (const specifier of imports) {
        expect(specifier).not.toMatch(/^\.{1,2}\//u)
        expect(specifier).not.toBe('effect')
        expect(specifier).not.toBe('@effect/platform')
      }
    },
  )

  it.each(modules)('$specifier avoids inline imports', ({ contents }) => {
    expect(contents).not.toMatch(/\bimport\(/u)
  })

  it.each(modules)(
    '$specifier resolves every sibling import',
    ({ specifier }) => {
      for (const dependency of importGraph.get(specifier) ?? []) {
        expect(importGraph.has(dependency)).toBe(true)
      }
    },
  )

  it('has no import cycles', () => {
    for (const specifier of importGraph.keys()) {
      expect(findCycle(specifier)).toBeUndefined()
    }
  })
})

describe('AGENTS module map', () => {
  const documentation = readFileSync(
    join(sourceRoot, '..', 'AGENTS.md'),
    'utf8',
  )
  const documented = new Set(
    [
      ...documentation.matchAll(/`(@fissionplane\/core\/[a-z0-9/-]+)`/gu),
    ].flatMap((match) => match[1] ?? []),
  )

  it('lists every shipped module and nothing that was deleted', () => {
    expect([...documented].toSorted(byName)).toEqual(
      modules.map((module) => module.specifier).toSorted(byName),
    )
  })
})
