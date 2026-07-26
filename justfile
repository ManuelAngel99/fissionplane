# Development entry points. CI runs exactly `just ci`, so a green local
# run means a green pipeline.

set dotenv-load := true

# List available recipes.
default:
    @just --list

# Everything CI enforces, in the order CI runs it.
ci: fmt-check clippy test check-guest lock deny

# Format everything in place, then run every linter, then every type
# checker, across Rust, TypeScript, Python, and the contracts. The
# fix-up pass before committing; `ci` is the read-only gate.
lint: fmt fmt-ts fmt-python clippy lint-ts lint-sdk-ts lint-python lint-spec check check-guest typecheck-ts typecheck-python

# Format the whole workspace in place.
fmt:
    cargo fmt --all

# Fail if anything is unformatted (CI mode).
fmt-check:
    cargo fmt --all --check

# Type-check every target without codegen.
check:
    cargo check --workspace --all-targets

# Type-check the guest crates for the Linux musl target. This compiles
# the cfg(linux) code — vm-init's real entrypoint — that a macOS host
# check never sees, and it works on any host because check does not
# link. Scoped to the guest crates: the Rust SDK's TLS stack needs a
# musl C toolchain that dev machines do not have.
check-guest:
    cargo check --all-targets --target x86_64-unknown-linux-musl -p vm-init -p vm-steward -p vm-protocol

# Lints are workspace-level deny already; -D warnings additionally
# promotes anything a future toolchain merely warns about.
clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# Install once: `cargo install cargo-nextest --locked` or `brew install cargo-nextest`.
# Run the test suite under cargo-nextest (per-test isolation, same runner as CI).
test:
    cargo nextest run --workspace

# Microbenchmarks (divan; currently the vm-protocol codec hot path).
bench:
    cargo bench -p vm-protocol

# Fail if Cargo.lock is stale relative to the manifests.
lock:
    cargo metadata --format-version 1 --locked --no-deps > /dev/null

# Supply-chain policy: advisories, licenses, bans, sources (deny.toml).
deny:
    cargo deny check

# Static musl builds of the two binaries that ship inside the guest.
# Linux-only in practice: macOS needs a musl cross linker.
build-guest:
    cargo build --release --locked --target x86_64-unknown-linux-musl -p vm-init -p vm-steward

# --- Per-language format / lint / type-check pieces (composed by `just lint`, useful standalone) ---

# Format the TypeScript workspace in place (oxfmt). Covers apps, libs,
# and the TypeScript SDK.
fmt-ts:
    cd src && pnpm run format

# Format the Python SDK in place (ruff).
fmt-python:
    cd src/sdks/python && uv sync --quiet && uv run ruff format .

# Lint the TypeScript apps and libs (type-aware oxlint).
lint-ts:
    cd src && pnpm run lint

# Lint the TypeScript SDK; the root oxlint pass only covers apps and libs.
lint-sdk-ts:
    cd src/sdks/typescript && pnpm run lint

# Lint the Python SDK (ruff).
lint-python:
    cd src/sdks/python && uv sync --quiet && uv run ruff check .

# Type-check the TypeScript workspace (per-package tsc / astro check),
# plus the marketing worker's separate tsconfig.
typecheck-ts:
    cd src && pnpm run typecheck
    cd src && pnpm --filter @fissionplane/marketing-site run worker:typecheck

# Type-check the Python SDK (ty).
typecheck-python:
    cd src/sdks/python && uv sync --quiet && uv run ty check

# --- Local development stack (docker compose: postgres, redis, clickhouse, minio) ---

# Start the datastores and wait for every healthcheck, then run the
# one-shot initialisers (bucket creation). `--wait` can't cover one-
# shots: an exited container reads as failure even on exit 0.
_dev-stores:
    docker compose up -d --wait postgres redis clickhouse minio
    docker compose run --rm minio-init

dev-up: _dev-stores

# Stop the datastores, keeping volumes.
dev-down:
    docker compose down

# Wipe every datastore volume and start fresh.
dev-reset:
    docker compose down --volumes
    @just _dev-stores

# Tail datastore logs.
dev-logs:
    docker compose logs --follow

# psql against the dev catalog.
psql:
    docker compose exec postgres psql --username fissionplane --dbname fissionplane

# redis-cli against the dev cache.
redis:
    docker compose exec redis redis-cli

# clickhouse-client against the dev analytics store.
clickhouse:
    docker compose exec clickhouse clickhouse-client --user fissionplane --password fissionplane-dev --database fissionplane

# Run a Rust app with hot restart on save (needs cargo-watch).
watch PKG:
    cargo watch --quiet --exec "run -p {{PKG}}"

# --- SDK generation (src/contracts/*.yaml is the source of truth) ---

# Regenerate the TypeScript and Python SDK cores from the contracts.
# Generated code is never edited by hand; CI fails if regenerating
# produces a diff.
#
# There is deliberately no generate-sdk-rust: Rust's OpenAPI client
# generators are too weak to lean on (a progenitor-based attempt was
# abandoned), so src/sdks/rust mirrors both contract documents by hand.
# A spec change therefore means editing the Rust models in the same PR;
# the guards are the spec's breaking-change CI job and the crate's
# wiremock suite, which pins the wire shapes the models must match.
generate-sdks: generate-sdk-typescript generate-sdk-python

# Types-only generation (openapi-typescript); the runtime client is
# openapi-fetch, typed against the generated schemas.
generate-sdk-typescript:
    cd src/sdks/typescript && pnpm install && pnpm run generate

# Full client-core generation, vendored under fissionplane/_api (control
# plane) and fissionplane/_dataplane. The generator version is pinned
# here; bumps are deliberate commits.
generate-sdk-python:
    rm -rf src/sdks/python/fissionplane/_api src/sdks/python/fissionplane/_dataplane
    uvx openapi-python-client@0.29.0 generate --path src/contracts/openapi.yaml --meta none --output-path src/sdks/python/fissionplane/_api
    uvx openapi-python-client@0.29.0 generate --path src/contracts/dataplane.yaml --meta none --output-path src/sdks/python/fissionplane/_dataplane
    rm -rf src/sdks/python/fissionplane/_api/.ruff_cache src/sdks/python/fissionplane/_dataplane/.ruff_cache

# Lint both contracts against the recommended ruleset (redocly.yaml).
lint-spec:
    pnpm --package=@redocly/cli@2 dlx redocly lint src/contracts/openapi.yaml src/contracts/dataplane.yaml

# Lint, typecheck, and unit-test the TypeScript and Python SDKs. The
# tests drive the handwritten wrappers against a mock control plane; the
# generated cores are covered by the drift check. The Rust SDK is a
# workspace member, so `just ci` covers it (fmt, clippy, test, deny).
check-sdks:
    cd src/sdks/typescript && pnpm install && pnpm run format:check && pnpm run lint && pnpm run typecheck && pnpm test
    cd src/sdks/python && uv sync --quiet && uv run ruff check . && uv run ruff format --check . && uv run ty check && uv run pytest -q

# --- TypeScript applications (Effect APIs and Vite consoles) ---

# Install every @fissionplane/* package from the single workspace lockfile.
install-ts:
    cd src && pnpm install --frozen-lockfile

# Format, lint, type-check, test, and build the TypeScript workspace.
check-ts:
    cd src && pnpm run check

# Run the tenant API and console together (ports 3101 and 3100).
dev-console:
    cd src && pnpm run dev:console

# Run the privileged operator API and backoffice together (3201 and 3200).
dev-backoffice:
    cd src && pnpm run dev:backoffice

# Generate and apply Drizzle migrations for app-owned auth/link schemas only.
# The Rust control plane remains the sole owner of catalog migrations.
generate-app-migrations:
    cd src && pnpm --filter @fissionplane/db run db:generate

migrate-apps:
    cd src && pnpm --filter @fissionplane/db run db:migrate
    cd src && pnpm dlx @better-auth/cli@latest migrate --config apps/console-api/src/auth.ts
    cd src && pnpm dlx @better-auth/cli@latest migrate --config apps/backoffice-api/src/auth.ts
