---
type: Guide
title: Local development
description: The SRE playbook for iterating on fissionplane locally — datastores in docker compose, platform binaries on the host, and the rules that keep the loop fast and honest.
tags: [development, sre, docker-compose, postgres, redis, clickhouse]
timestamp: 2026-07-28T14:30:00Z
---

# Local development

The loop is built around one decision: **datastores run in docker
compose, platform binaries run on the host.** Containers give the
stores reproducible versions, healthchecks, and one-command teardown;
the host gives the Rust binaries sub-second recompiles, real debuggers,
and `cargo watch` restarts. Putting the binaries in compose would buy
nothing locally — you would rebuild images to see a log line — and
their deploy manifests (Kubernetes, per `docs/index.md`) already own
containerisation for real environments.

## The stack

`docker-compose.yml` at the repo root provides the four stores the
architecture names (`docs/architecture/overview.md`), plus the
analytics store:

| Store | Role | Truth? | Host port |
|---|---|---|---|
| Postgres 17 | Organisations, quotas, templates, sandboxes, snapshots, API keys | **Source of truth** | `5433` |
| Redis 7 | Routing cache, rate limits, short-lived locks | Never — rebuildable cache | `6380` |
| ClickHouse 25 | Usage metering and analytics | Durable analytics | `8123` / `9002` |
| MinIO | S3-compatible artifact storage (templates, snapshots, layers) | Durable artifact truth | `9000` / `9001` (console) |

Everything binds `127.0.0.1` only, every port is overridable in `.env`
(copy `.env.example`), and every service has a healthcheck — dependents
wait with `condition: service_healthy`, never with sleeps.

## Daily loop

```sh
cp .env.example .env     # once
just dev-up              # start stores, waits for healthchecks

just watch control-plane # hot-restart on save (needs cargo-watch)
just psql                # inspect the catalog
just dev-logs            # what the stores are doing

just dev-down            # stop, keep data
just dev-reset           # wipe every volume, start clean
```

### Web applications

The TypeScript workspace lives at `src/` and uses one pnpm lockfile.
Node 24 and pnpm 10 are the supported toolchain. The two browser/API
pairs run independently from the Rust control plane:

```sh
cd src && pnpm install
just generate-app-migrations
just migrate-apps

just dev-console          # console-web :3100, console-api :3101
just dev-backoffice       # backoffice-web :3200, backoffice :3201
```

Both Vite development servers proxy `/api` to their paired Effect HTTP
server, so Better Auth cookies remain same-origin in the browser.
Tenant and operator authentication deliberately use different secrets,
cookies, Better Auth instances, and PostgreSQL schemas.

`@fissionplane/db` owns only `tenant_auth` and `backoffice_auth`.
Drizzle must never create or alter catalog tables. The Rust control
plane and sqlx remain the sole owners of platform organisations,
projects, sandboxes, quotas, and API keys.

Unit tests never touch the stores — `just test` (nextest) runs with
the stack down. When a component grows real queries, its integration
tests get a throwaway compose project (`docker compose -p
fissionplane-test-$CI_JOB_ID ...`) or testcontainers.

## Rules that keep the loop honest

1. **Postgres is truth, Redis is cache, always.** Locally this means
   `just dev-reset` must never lose anything you care about — if it
   does, that data belonged in Postgres or MinIO. Redis runs with no
   AOF and no volume on purpose: losing it exercises the same refill
   path as production.
2. **Version parity.** Compose pins the same major versions production
   runs. Bumps are deliberate, single-purpose commits — an untracked
   drift between your laptop and prod is how "works on my machine"
   happens (same discipline as the pinned Rust toolchain).
3. **Credentials are dev-only and committed nowhere.** `.env` is
   gitignored; `.env.example` carries the defaults. The passwords are
   public knowledge by design — their only job is to be obviously
   worthless.
4. **Migrations own schema, not init scripts.** The
   `deploy/dev/*/initdb` scripts only perform database-level bootstrap work;
   no extension is currently required for application-generated NanoIDs.
   Table DDL arrives with the catalog implementation as
   forward-only, numbered migrations in
   `src/apps/control-plane/migrations` (sqlx; `sqlx migrate run`
   becomes a `just migrate` recipe and a CI gate). Never edit an
   applied migration — add a new one.
5. **Adding a store is a checklist, not a vibes decision:** healthcheck,
   pinned image, localhost-only port overridable via `.env`, a volume
   only if the data is durable, a `just` recipe to reach its CLI, and a
   row in the table above.
6. **Hot restart, not hot reload.** `cargo watch -x 'run -p <crate>'`
   restarts the binary on save; for heavier exploration `bacon`
   (`cargo install bacon`) gives a TUI over the same idea. The dev
   profile is already tuned for this (build-override `opt-level = 3`,
   plus `--profile quick` for binaries you run but never ship).

## Observability direction

Today the binaries log structured events to stdout (`tracing`,
`RUST_LOG` env) and the stores log to `just dev-logs`. The growth path
is incremental, not a leap to production telemetry: an
`otel-collector` service in compose receiving OTLP from the binaries,
with ClickHouse (or Grafana + Tempo/Loki) as
the sink. Add it when the first cross-component trace is needed —
before that, it is furniture.

## Troubleshooting

- **Port already in use** — another Postgres/Redis (Homebrew) or a
  previous run. Override in `.env` (`POSTGRES_PORT`, `REDIS_PORT`,
  ...); do not edit the compose file for a local collision.
- **ClickHouse is heavy on a laptop** — `docker compose stop
  clickhouse` when you are not touching metering; nothing else depends
  on it yet.
- **MinIO init did not create the bucket** — `just dev-logs` and look
  at `minio-init`; `mc` tag and `minio` tag are bumped together.
- **Stale everything** — `just dev-reset`, then `cargo clean` only if
  the toolchain also changed.
- **A local auth schema predates the NanoID initial migration** — the
  pre-release migration was replaced; run `just dev-reset` rather than
  preserving pre-release UUID-backed local data.
