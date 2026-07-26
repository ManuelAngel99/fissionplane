/**
 * Package identity attached to every request the SDK sends.
 *
 * `sdkVersion` is a constant rather than an import of `package.json` so the
 * module resolves identically under `main: src/index.ts` and under a bundled
 * `dist` build. `tests/metadata.test.ts` keeps it in step with the manifest.
 */

/** The version of `@fissionplane/sdk` this build was cut from. */
export const sdkVersion = '0.0.1-beta'

/** Product token identifying the SDK to the control plane and the agent. */
export const userAgent = `fissionplane-typescript/${sdkVersion}`

/** Headers every request carries unless the caller supplies its own. */
export const defaultHeaders: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': userAgent,
})
