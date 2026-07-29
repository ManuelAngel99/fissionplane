# FissionPlane product documentation

Public product documentation for [FissionPlane](https://fissionplane.dev),
served at [fissionplane.dev/docs](https://fissionplane.dev/docs).

This app contains installation instructions, SDK guides, product concepts, and
API reference material. Internal architecture and contributor documentation
lives in the repository's top-level [`docs`](../../../docs) directory.

## Local development

```sh
cd src
pnpm install
pnpm --filter @fissionplane/fissionplane-docs dev
```

The preview is available at `http://localhost:3000`.

Before submitting documentation changes, run:

```sh
pnpm --filter @fissionplane/fissionplane-docs validate
pnpm --filter @fissionplane/fissionplane-docs broken-links
pnpm --filter @fissionplane/fissionplane-docs a11y
```

## Deployment

Mintlify deploys this directory from the `main` branch of
[`ManuelAngel99/fissionplane`](https://github.com/ManuelAngel99/fissionplane).
The deployment's Git settings must enable **docs.json is in a subdirectory**
with `src/apps/fissionplane-docs` as the directory.
