# SDK releases

The TypeScript, Python, and Rust SDKs use one lockstep release train. A release
has one semantic version and one immutable tag:

```text
sdks/v0.1.0
sdks/v0.2.0-beta
sdks/v0.2.0-beta.1
```

Python uses the equivalent PEP 440 spelling (`0.2.0b0`, `0.2.0b1`) in its
package metadata.

## Release model

Merging SDK code does not publish packages. Every pull request is validated by
`SDKs CI`; a release remains an explicit maintainer decision:

1. Open a release pull request that updates all version declarations.
2. Merge it only after `SDKs CI Status` passes.
3. Tag that merge commit and push the tag.
4. `Release SDKs` repeats the tests and packaging checks from the tagged commit.
5. Protected registry jobs publish the three packages.
6. The workflow verifies all three public registries and creates the GitHub
   Release with checksums and built distributions.

This gives weekly releases a reviewable version bump without publishing every
merge to `main`.

## Why the tag comes before publishing

The tag is the immutable source identity and retry point for a release attempt,
not proof that every registry accepted it. npm, PyPI, and crates.io cannot be
updated atomically: one upload can succeed while another registry is
temporarily unavailable.

The workflow therefore:

- runs every test and package dry-run before any upload;
- never moves or deletes a release tag after an upload attempt;
- treats an already-present matching version as a successful retry;
- creates the user-facing GitHub Release only after all three registries are
  verified.

If a publish job fails, fix credentials or registry configuration and use
**Re-run failed jobs** on the same workflow run. Do not replace the tag and do
not bump the version merely to retry infrastructure.

## Preparing a release

Choose the next version according to SemVer. Before `1.0.0`, incompatible API
changes normally bump the minor version and compatible fixes bump the patch
version. Use prerelease identifiers only when the release should not be the
stable default.

Update these files in one pull request:

- `src/sdks/typescript/package.json`
- `src/sdks/typescript/src/api/metadata.ts`
- `src/sdks/rust/Cargo.toml`
- `src/sdks/python/pyproject.toml`
- `src/sdks/python/fissionplane/_version.py`
- `Cargo.lock` and `src/sdks/python/uv.lock`
- SDK changelogs or release notes, when present

Validate the proposed tag locally:

```bash
python3 scripts/check_sdk_release_version.py sdks/v0.1.0
just check-sdks
cargo test --locked -p fissionplane
cargo publish --locked -p fissionplane --dry-run
```

After the pull request is merged, tag the exact merge commit on `main`:

```bash
git switch main
git pull --ff-only
git tag -s sdks/v0.1.0 -m "FissionPlane SDKs 0.1.0"
git push origin sdks/v0.1.0
```

Signed tags are recommended. Protect the `sdks/v*` pattern with a GitHub
repository ruleset so only release maintainers can create matching tags.

## One-time registry configuration

The workflow uses three GitHub environments. Create `npm`, `pypi`, and
`crates-io` under **Repository settings → Environments**. Restrict deployment
branches/tags to `sdks/v*` and add required reviewers if releases need a final
human approval.

### npm trusted publisher

Configure `@fissionplane/sdk` on npm with:

- Provider: GitHub Actions
- Repository: `ManuelAngel99/fissionplane`
- Workflow file: `release-sdks.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The npm job requests `id-token: write`; npm exchanges that OIDC identity for a
short-lived credential and automatically records provenance. No `NPM_TOKEN`
secret is used.

### PyPI trusted publisher

Under the `fissionplane` project's publishing settings on PyPI, add a GitHub
Actions trusted publisher:

- Owner: `ManuelAngel99`
- Repository: `fissionplane`
- Workflow: `release-sdks.yml`
- Environment: `pypi`

The official PyPA publish action performs the OIDC exchange. Remove any
long-lived PyPI token from repository secrets after this is tested.

### crates.io token

crates.io does not currently support trusted publishing. Create a token scoped
to the `fissionplane` crate with publish-new/publish-update permissions and add
it as the `CARGO_REGISTRY_TOKEN` secret on the `crates-io` environment.

Use a dedicated CI token, rotate it periodically, and revoke any token that has
been pasted into chat or logs.

## Repository protections

For a release process that remains trustworthy:

- require `SDKs CI Status` before merging SDK release pull requests;
- require review for changes to `.github/workflows/release-sdks.yml`;
- protect the `sdks/v*` tag namespace;
- require reviewers on registry environments for manual release approval;
- allow only GitHub-hosted runners for the OIDC publishing jobs;
- never run publishing steps for pull requests or untrusted forks.
