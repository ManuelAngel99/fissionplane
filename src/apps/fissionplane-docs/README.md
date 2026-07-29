# FissionPlane product documentation

Public product documentation for [FissionPlane](https://fissionplane.dev),
served at [fissionplane.dev/docs](https://fissionplane.dev/docs).

This app contains installation instructions, SDK guides, product concepts, and
API reference material. Internal architecture and contributor documentation
lives in the repository's top-level [`docs`](../../../docs) directory.

## Local development

```sh
just install-ts
just dev-docs
```

The preview is available at `http://localhost:3000`.

Before submitting documentation changes, run:

```sh
just check-docs
```

Use `just validate-docs`, `just check-docs-links`, or `just check-docs-a11y`
when you need one check in isolation.

## Deployment

Mintlify deploys this directory from the `main` branch of
[`ManuelAngel99/fissionplane`](https://github.com/ManuelAngel99/fissionplane).
The deployment's Git settings must enable **docs.json is in a subdirectory**
with `src/apps/fissionplane-docs` as the directory.

`.github/workflows/docs.yml` runs the same validation for pull requests and
pushes that affect this app. Mintlify deploys accepted changes from `main`
through its GitHub App; no publishing secret is stored in GitHub Actions.
