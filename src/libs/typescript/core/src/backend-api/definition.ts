import { BackofficeOperationsApiGroup } from '@fissionplane/core/backend-api/routes/backoffice/api'
import { SandboxesApiGroup } from '@fissionplane/core/backend-api/routes/sandboxes/api'
import { SystemApiGroup } from '@fissionplane/core/backend-api/routes/system/api'
import {
  InternalError,
  UnauthenticatedError,
  UnauthorizedError,
} from '@fissionplane/core/ddd/base-error'
import * as HttpApi from '@effect/platform/HttpApi'

/**
 * Tenant-facing contract served by `@fissionplane/console-api`.
 *
 * `InternalError` is declared once at the root because the host serializes
 * escaped defects with that body; without it a generated client would decode
 * a 500 as an untyped transport error.
 */
export class ConsoleApi extends HttpApi.make('console')
  .add(SystemApiGroup)
  .add(SandboxesApiGroup)
  .addError(InternalError)
  .prefix('/api') {}

/**
 * Operator-facing contract served by `@fissionplane/backoffice-api`.
 *
 * The operator gate guarding the whole surface runs before Effect, so the
 * authentication and authorization failures are declared at the root rather
 * than on a middleware tag; backoffice access is a global trust domain and
 * never reuses tenant organization roles.
 */
export class BackofficeApi extends HttpApi.make('backoffice')
  .add(BackofficeOperationsApiGroup)
  .addError(UnauthenticatedError)
  .addError(UnauthorizedError)
  .addError(InternalError)
  .prefix('/api') {}
