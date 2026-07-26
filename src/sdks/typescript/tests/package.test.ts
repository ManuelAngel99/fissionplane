import { describe, expect, test } from 'vitest'

import manifest from '../package.json' with { type: 'json' }

describe('publishable package', () => {
  test('the manifest points consumers at the built bundle', () => {
    expect(manifest.main).toBe('./dist/index.cjs')
    expect(manifest.module).toBe('./dist/index.js')
    expect(manifest.types).toBe('./dist/index.d.ts')
    expect(manifest.exports['.']).toEqual({
      import: { types: './dist/index.d.ts', default: './dist/index.js' },
      require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
    })
  })

  test('the manifest ships only the bundle and is public', () => {
    expect(manifest.files).toEqual(['dist', 'README.md'])
    expect(manifest.sideEffects).toBe(false)
    expect(manifest.engines.node).toBe('>=20')
    expect('private' in manifest).toBe(false)
    expect(manifest.publishConfig.access).toBe('public')
  })

  test('the build and docs scripts are wired to their tools', () => {
    expect(manifest.scripts.build).toBe('tsc --noEmit && tsdown')
    expect(manifest.scripts.docs).toBe('typedoc --out docs src/index.ts')
    expect(manifest.devDependencies).toHaveProperty('tsdown')
    expect(manifest.devDependencies).toHaveProperty('typedoc')
  })
})
