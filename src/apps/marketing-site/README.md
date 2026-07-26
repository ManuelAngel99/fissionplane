# `@fissionplane/marketing-site`

Public Astro marketing site for FissionPlane. Hosted on Cloudflare (Workers static assets).

## Commands

From `src/apps/marketing-site` (or via pnpm filter from `src/`):

| Command          | Action                               |
| ---------------- | ------------------------------------ |
| `pnpm dev`       | Local Astro dev server               |
| `pnpm build`     | Build static site to `./dist`        |
| `pnpm preview`   | Preview the production build locally |
| `pnpm cf:deploy` | Build and deploy with Wrangler       |

From the TypeScript workspace root (`src/`):

```sh
pnpm --filter @fissionplane/marketing-site dev
pnpm --filter @fissionplane/marketing-site cf:deploy
```

## Cloudflare

This is a static Astro site. Wrangler deploys `./dist` as static assets (the current Cloudflare path for Astro; same role as classic Pages).

1. Log in with the account that should own the project (personal vs work):

   ```sh
   pnpm exec wrangler logout
   pnpm exec wrangler login
   pnpm exec wrangler whoami
   ```

2. Deploy:

   ```sh
   pnpm cf:deploy
   ```

Git-connected builds: set the app root to `src/apps/marketing-site`, build command `pnpm build`, and deploy command `npx wrangler deploy` (or use Workers Builds).
