# `@fissionplane/marketing-site`

Public Astro marketing site for FissionPlane. Hosted on Cloudflare (Workers static assets).

## Commands

From `src/apps/marketing-site` (or via pnpm filter from `src/`):

| Command           | Action                                   |
| ----------------- | ---------------------------------------- |
| `pnpm dev`        | Local Astro dev server                   |
| `pnpm build`      | Build static site to `./dist`            |
| `pnpm preview`    | Preview the production build locally     |
| `pnpm cf:deploy`  | Deploy an existing build with Wrangler   |
| `pnpm cf:dry-run` | Validate an existing build locally       |

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
   pnpm build
   pnpm cf:deploy
   ```

Production deploys run from `.github/workflows/deploy-marketing.yml` after
marketing-site formatting, lint, typechecks, build, and a Wrangler dry-run pass.
Configure these GitHub Actions repository secrets once:

- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account that owns the Worker.
- `CLOUDFLARE_API_TOKEN`: an API token scoped to that account with Workers
  Scripts Edit and Workers Routes Edit for the `fissionplane.dev` zone.
