# `@fissionplane/core`

Client-safe domain contracts shared by every TypeScript app: value objects,
permissions, domain errors, HTTP contracts, and frontend route catalogs.

Keep this file in sync. When you add, rename, move, or delete a module or a
public export, update the tables below in the same change —
`tests/package-boundaries.test.ts` fails when the module map and `src/` drift.

## Module map

Import subpaths directly. There is no barrel.

| Module              | Import path                                                 | Exports                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error codes         | `@fissionplane/core/ddd/codes`                              | `ErrorCode`, `ErrorCodeKey`, `ErrorCodeEntry`                                                                                                                                                                                |
| Error base          | `@fissionplane/core/ddd/base-error`                         | `DomainError`, `UnauthenticatedError`, `UnauthorizedError`, `InternalError`                                                                                                                                                  |
| Canonical IDs       | `@fissionplane/core/shared/identifiers`                     | `NANO_ID_ALPHABET`, `NANO_ID_LENGTH`, `NANO_ID_PATTERN`, `NanoIdSchema`, `NanoId`, `canonicalIdSchema`, `generateNanoId`                                                                                                     |
| Name primitives     | `@fissionplane/core/shared/names`                           | `DISPLAY_NAME_PATTERN`, `DNS_LABEL_PATTERN`, `RESOURCE_DESCRIPTION_MIN_LENGTH`, `RESOURCE_DESCRIPTION_MAX_LENGTH`, `displayNameSchema`, `dnsLabelSchema`, `ResourceDescriptionSchema`, `ResourceDescription`                 |
| Organization types  | `@fissionplane/core/organizations/types`                    | `ORGANIZATION_NAME_*`, `ORGANIZATION_SLUG_*`, `OrganizationIdSchema`, `OrganizationNameSchema`, `OrganizationSlugSchema`, `OrganizationRoleSchema`, `OrganizationPermissionSchema`, matching types, `generateOrganizationId` |
| Organization RBAC   | `@fissionplane/core/organizations/permissions`              | `statements`, `accessControl`, `roleStatements`, `owner`, `admin`, `developer`, `viewer`, `organizationRoles`, `hasOrganizationPermission`                                                                                   |
| Organization errors | `@fissionplane/core/organizations/errors`                   | `ForbiddenError`, `ActiveOrganizationRequiredError`                                                                                                                                                                          |
| User types          | `@fissionplane/core/users/types`                            | `USER_ID_*`, `USER_DISPLAY_NAME_*`, `UserIdSchema`, `UserDisplayNameSchema`, matching types                                                                                                                                  |
| Better Auth IDs     | `@fissionplane/core/auth/types`                             | `AUTH_ORGANIZATION_ID_*`, `AuthOrganizationIdSchema`, `AuthOrganizationId`                                                                                                                                                   |
| Request subject     | `@fissionplane/core/auth/models`                            | `AuthenticatedMemberSchema`, `AuthenticatedMember`                                                                                                                                                                           |
| Sandbox types       | `@fissionplane/core/sandboxes/types`                        | `SANDBOX_NAME_*`, `SandboxIdSchema`, `SandboxNameSchema`, `SandboxStateSchema`, matching types, `generateSandboxId`                                                                                                          |
| Sandbox read models | `@fissionplane/core/sandboxes/views`                        | `SandboxSummarySchema`, `SandboxSummary`                                                                                                                                                                                     |
| Template types      | `@fissionplane/core/templates/types`                        | `TEMPLATE_ALIAS_*`, `TemplateIdSchema`, `TemplateBuildIdSchema`, `TemplateAliasSchema`, matching types, `generateTemplateId`, `generateTemplateBuildId`                                                                      |
| Artifact types      | `@fissionplane/core/artifacts/types`                        | `ARTIFACT_ID_PREFIX`, `ARTIFACT_DIGEST_HEX_LENGTH`, `ARTIFACT_ID_LENGTH`, `ARTIFACT_ID_PATTERN`, `ArtifactIdSchema`, `ArtifactId`                                                                                            |
| Service health      | `@fissionplane/core/system/types`                           | `ServiceNameSchema`, `ServiceName`, `HealthSchema`, `Health`                                                                                                                                                                 |
| API roots           | `@fissionplane/core/backend-api/definition`                 | `ConsoleApi`, `BackofficeApi`                                                                                                                                                                                                |
| Auth middleware tag | `@fissionplane/core/backend-api/middlewares/authentication` | `AuthenticatedMemberContext`, `OrganizationAuthenticationFailureSchema`, `OrganizationAuthentication`                                                                                                                        |
| System routes       | `@fissionplane/core/backend-api/routes/system/api`          | `SystemApiGroup`                                                                                                                                                                                                             |
| Sandbox routes      | `@fissionplane/core/backend-api/routes/sandboxes/api`       | `SandboxesApiGroup`                                                                                                                                                                                                          |
| Backoffice routes   | `@fissionplane/core/backend-api/routes/backoffice/api`      | `BackofficeOperationsApiGroup`                                                                                                                                                                                               |
| Frontend routes     | `@fissionplane/core/frontend/routes`                        | `CONSOLE_SANDBOX_ID_PARAM`, `consoleRoutes`, `consoleRoute`, `backofficeRoutes`                                                                                                                                              |

## Security boundary

This package ships to browsers. It must never contain:

- database clients, Drizzle schemas, or SQL,
- Better Auth _server_ instances, secrets, or `process.env` reads,
- Node built-ins, HTTP servers, or request handlers,
- imports from `@fissionplane/api`, `@fissionplane/db`, or any app package.

`tsconfig.json` compiles `src` with `"types": []`, so a Node global will not
even typecheck; `tsconfig.tests.json` adds `@types/node` for `tests` alone.
`tests/package-boundaries.test.ts` enforces the rest of the rule and proves the
module graph is acyclic.

Better Auth's client-safe access-control builders (`better-auth/plugins/access`)
are allowed because the permission matrix must be identical on both sides. That
is the only Better Auth subpath core may import.

`package.json` declares `"sideEffects": false`, so every module must stay free of
import-time effects: no logging, timers, global mutation, or environment reads at
module scope.

## Imports

- Absolute `@fissionplane/*` specifiers only. Relative source imports are a lint
  error across the workspace, and inline `import(...)` types — including inside
  doc comments — are banned because they hide edges from the module graph.
- Import Effect from the narrowest subpath (`effect/Schema`, `effect/Context`),
  not the `effect` barrel, and `@effect/platform/HttpApi` rather than
  `@effect/platform`.
- `exports` is a single wildcard (`"./*": "./src/*.ts"`). A new file is publicly
  importable the moment it exists; there is no barrel to update.
- Weigh what each module drags into a browser chunk. `organizations/permissions`
  is imported by both Better Auth clients, so it holds no Effect import at all
  and takes `OrganizationRole` and `OrganizationPermission` as type-only imports
  from `organizations/types`; the schemas for those two unions live there. Moving
  them back would pull the whole schema runtime into the console's first paint.

## Schema naming

Runtime Effect schemas are `FooSchema`; the decoded TypeScript type is `Foo`.
Never export a const and a type under the same name, and do not add
`Foo = FooSchema` aliases — construct with `FooSchema.make(...)`.

Error classes are the one exception: a class is both value and type, so
`ForbiddenError` keeps its plain name.

## Value objects

Canonical resource IDs are 24-character lowercase-alphanumeric NanoIDs
(~124 bits of entropy) built through `canonicalIdSchema`, so `OrganizationId`,
`SandboxId`, `TemplateId`, and `TemplateBuildId` share one format while staying
distinct brands.

Three identifier families deliberately do **not** use that format:

- `UserId` and `AuthOrganizationId` are Better Auth-owned bounded external
  strings.
- `ArtifactId` is a content digest: lowercase `sha256:` plus 64 hex characters.

Every bound is an exported constant. Schemas, UI parsers, error messages,
generators, and tests must read those constants instead of repeating literals;
`ORGANIZATION_SLUG_MAX_LENGTH` and `NANO_ID_LENGTH`, for example, are what size
the console's generated slug prefix.

| Value object          | Bounds | Shape        |
| --------------------- | ------ | ------------ |
| `OrganizationName`    | 1–100  | display name |
| `UserDisplayName`     | 1–80   | display name |
| `OrganizationSlug`    | 1–63   | DNS label    |
| `SandboxName`         | 1–63   | DNS label    |
| `TemplateAlias`       | 1–63   | DNS label    |
| `ResourceDescription` | 1–2000 | display name |

Display names reject padding and Unicode control characters; DNS labels are
lowercase with alphanumeric edges. Both bounds and both patterns mirror
`src/libs/rust/domain`, which owns the same value objects for the control plane.

## Domain errors

`ddd/codes.ts` owns the HTTP status and default message per failure class.
`ddd/base-error.ts` turns those into tagged error classes through
`DomainError<Self>()(tag, code, message, statusCode, fields)`. The factory adds a
literal `code` field and a defaulted `message` field to the schema, so every
error encodes to a stable JSON body and carries its status as an
`HttpApiSchema` annotation.

| Class                             | Module                 | Status | Use when                                                                                                                                   |
| --------------------------------- | ---------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `UnauthenticatedError`            | `ddd/base-error`       |    401 | No valid Better Auth session.                                                                                                              |
| `UnauthorizedError`               | `ddd/base-error`       |    403 | Authenticated but barred from a surface: the backoffice gate, or a tenant session whose active organization membership cannot be resolved. |
| `InternalError`                   | `ddd/base-error`       |    500 | Unexpected server failure.                                                                                                                 |
| `ForbiddenError`                  | `organizations/errors` |    403 | The member's organization role lacks a permission. Carries `permission` on the wire.                                                       |
| `ActiveOrganizationRequiredError` | `organizations/errors` |    403 | The session has no active organization to scope the request.                                                                               |

Add an error only when a real path fails that way. Extra fields are part of the
public wire contract, so never put server-only context in them.

Anything a host can emit for a route must be declared on that route, or the
generated `HttpApiClient` decodes it as an untyped transport failure. Both API
roots therefore add `InternalError`, since the Node host serializes escaped
defects with that exact body.

## HTTP contracts

`backend-api/routes/<surface>/api.ts` declares one `HttpApiGroup`;
`backend-api/definition.ts` composes the groups into `ConsoleApi` (`system`,
`sandboxes`) and `BackofficeApi` (`operations`), both prefixed `/api`.

Route DTOs live beside the route only when the transport shape differs from the
domain. Today `SandboxSummarySchema` and `HealthSchema` are reused directly, so
no `dtos.ts` exists yet; add one rather than bending a domain schema to fit a
wire change.

`backend-api/middlewares/authentication.ts` is tag-only. `SandboxesApiGroup`
declares `OrganizationAuthentication`, which provides `AuthenticatedMemberContext`
to handlers and fails with `OrganizationAuthenticationFailureSchema` — the
missing-session 401 the live layer raises plus the two 403s the Better Auth host
raises before Effect runs. The live layer stays in `@fissionplane/api`; it decodes
the trusted internal headers the host writes after resolving the session. Never
implement authentication here.

`BackofficeApi` carries its authentication and authorization failures at the
root instead: the operator gate covers the whole surface and is a separate trust
domain that never reuses tenant roles.

## Tests

`tests/` mirrors `src/`: a covered `src/foo/bar.ts` is tested by
`tests/foo/bar.test.ts`. `tests/package-boundaries.test.ts` is the one
exception; it checks the package as a whole. Use `@fissionplane/core/…`
specifiers so tests resolve the same paths consumers use.

Prefer `Schema.decodeUnknownEither` at boundaries — it proves acceptance _and_
rejection with the real decoder. `Schema.is` is fine for cheap literal-union
membership. Do not add snapshot tests for trivial structures.

## Required checks

Run from `src/`:

```sh
pnpm format:check
pnpm lint
pnpm --filter @fissionplane/core typecheck
pnpm --filter @fissionplane/core test
```

Changing a public export means updating every consumer in the same change:
`@fissionplane/api`, `@fissionplane/db`, both API hosts, and both Vite SPAs. Run
`pnpm check` from `src/` before you call it done.
