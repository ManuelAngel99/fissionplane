# TypeScript application architecture

The TypeScript workspace separates client-safe contracts, application
behavior, infrastructure, deployable hosts, and browser features.

## Package responsibilities

- `src/libs/typescript/core` (`@fissionplane/core`) contains domain value
  schemas, HTTP definitions, permissions, and frontend route catalogs. It is
  safe to import in browsers. Its modules are grouped by domain
  (`organizations/`, `users/`, `sandboxes/`, `templates/`, `artifacts/`,
  `auth/`, `system/`) plus cross-cutting `ddd/`, `shared/`, `backend-api/`,
  and `frontend/`. There is no barrel: consumers import the exact subpath,
  such as `@fissionplane/core/organizations/permissions`. It compiles with
  `"types": []`, so a Node built-in or global cannot reach a browser bundle
  through it. Package-local conventions live in
  [`src/libs/typescript/core/AGENTS.md`](../src/libs/typescript/core/AGENTS.md).
- `src/libs/typescript/api` (`@fissionplane/api`) contains application use
  cases, domain ports, infrastructure adapters, HTTP controllers, and Effect
  composition roots.
- `src/libs/typescript/db` (`@fissionplane/db`) owns Drizzle schemas and
  migrations for `tenant_auth` and `backoffice_auth`. It never owns the Rust
  control-plane catalog.
- `src/apps/console-api` and `src/apps/backoffice-api` are deployable
  composition hosts. They configure Better Auth and start their HTTP servers.
- `src/apps/console-web` and `src/apps/backoffice-web` are Vite SPAs.

## Value objects and identifiers

Domain primitives are Effect Schema value objects, not interchangeable
strings. Canonical resource IDs use a secure 24-character
lowercase-alphanumeric NanoID (approximately 124 bits of entropy), branded
separately as `OrganizationId`, `SandboxId`, `TemplateId`, and
`TemplateBuildId`.

Names, slugs, aliases, and descriptions have their own branded schemas with
length, normalization, character, and control-character validation. Validation
happens at boundaries; code inside a use case receives the branded type. Every
minimum and maximum bound is an exported constant owned by the value-object
module; UI parsers, messages, generators, and tests consume those constants
instead of repeating numeric literals.

Not every identifier is an FissionPlane NanoID:

- Better Auth owns `UserId` and `AuthOrganizationId`; they are branded,
  non-empty external IDs.
- Artifact IDs are immutable content digests and retain digest validation.
- Request IDs and idempotency keys can be supplied by callers and follow their
  own contracts.

Runtime Effect schemas are named `FooSchema` and the decoded TypeScript type is
`Foo`, so a value object never exports a const and a type under one name.
Construction goes through `FooSchema.make(...)`.

## Domain errors

`@fissionplane/core/ddd/codes` owns the HTTP status and default message for each
failure class, and `@fissionplane/core/ddd/base-error` turns them into tagged
error classes through the `DomainError` factory. Each class carries a literal
machine-readable `code`, a defaulted `message`, and its HTTP status as a schema
annotation, so an Effect endpoint and a gate that runs before Effect serialize
the same JSON body.

Every failure a host can produce for a route is declared on that route, because
a generated `HttpApiClient` decodes anything undeclared as an untyped transport
error. Both API roots add `InternalError` for escaped defects, the tenant
authentication middleware declares the 401 and the two 403s the console gate can
emit, and the backoffice root declares its operator-gate failures.

## Backend dependency rule

Dependencies point inward:

```text
HTTP controller
  -> application use case
    -> domain service or repository port
      <- infrastructure adapter
```

Controllers decode transport input, invoke one use case, and return the
contract response. Use-case DTOs describe the application boundary and do not
contain HTTP or database types. A use case coordinates domain behavior and
transaction boundaries. Repositories persist and retrieve aggregates.

Domain services are only introduced for domain behavior that does not
naturally belong to one aggregate. A pass-through service between a use case
and a repository is forbidden.

Each backend feature lives under:

```text
modules/<feature>/
  domain/
    entities/
    value-objects/
    services/
    repositories/
  application/
    <use-case>/
      <use-case>.dto.ts
      <use-case>.use-case.ts
  infrastructure/
    http/
      <feature>.controller.ts
    repositories/
      <repository>-live.ts
```

Effect `Context.Tag` values define ports. Composition roots select their live
layers; domain and application modules never import live infrastructure.

## Organization RBAC

Tenant authorization is organization-scoped and intentionally does not use
FGA. `@fissionplane/core/organizations/permissions` is the single permission
matrix used by both Better Auth's organization plugin and the pure domain
permission check. The supported membership roles are `owner`, `admin`,
`developer`, and `viewer`.

The console HTTP boundary resolves the Better Auth session, active
organization, and membership role once per request. It strips the internal
subject headers from every inbound request and rewrites them only after the
session resolves, so a browser cannot forge them. The
`OrganizationAuthentication` middleware decodes those headers into
`AuthenticatedMember` and provides it to handlers; nothing trusts an
organization or role supplied by a browser payload.

Which requests the gate resolves is derived from the contract itself: the host
reflects `ConsoleApi` for the endpoints that declare the middleware. Declaring
authentication on a new group extends the gate automatically, and the
unauthenticated liveness probe keeps answering without a session instead of
returning a 401 the contract never published.

The middleware is declared tag-only in
`@fissionplane/core/backend-api/middlewares/authentication` so the contract stays
client-safe, and its live layer lives in `@fissionplane/api`. Because a handler
can only obtain the subject from that middleware, an authenticated endpoint
cannot forget to declare authentication and still compile.

Use cases receive the typed subject and call `OrganizationRbacService` before
accessing repositories. Repository methods also require the organization
scope, providing two independent safeguards:

```text
Better Auth membership
  -> authenticated organization subject
    -> use-case permission check
      -> organization-scoped repository call
```

Permission denial is represented by the typed `ForbiddenError` and maps to
HTTP 403 through the Effect HTTP contract. Backoffice administrator
authorization remains a separate global trust domain and does not reuse
tenant organization roles.

## Frontend dependency rule

React Router owns URL routing. Route modules are lazy and pages are thin:

```text
src/
  app/
    router.tsx
    providers.tsx
    layouts/
  features/<feature>/
    page.tsx
    components/
    hooks/
    providers/
    api.ts
```

Feature code may import shared app components and `@fissionplane/core`.
Features must not import another feature's private components. Cross-feature
UI belongs in an app-level `components/` directory or a future
`@fissionplane/ui` package.

All internal imports use the package's `@fissionplane/*` self-alias. Relative
source imports are rejected by oxlint.
