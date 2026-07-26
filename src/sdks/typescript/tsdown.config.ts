import { defineConfig } from 'tsdown'

/**
 * Produces the publishable bundle: ESM plus CommonJS, each with type
 * declarations, from the single `src/index.ts` entry point.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: ['esm', 'cjs'],
  // `type: module` makes `.js` the ESM extension; CommonJS keeps `.cjs`.
  fixedExtension: false,
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  treeshake: true,
})
