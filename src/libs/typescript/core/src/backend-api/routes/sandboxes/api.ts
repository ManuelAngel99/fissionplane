import { OrganizationAuthentication } from '@fissionplane/core/backend-api/middlewares/authentication'
import { ForbiddenError } from '@fissionplane/core/organizations/errors'
import { SandboxSummarySchema } from '@fissionplane/core/sandboxes/views'
import * as HttpApiEndpoint from '@effect/platform/HttpApiEndpoint'
import * as HttpApiGroup from '@effect/platform/HttpApiGroup'
import * as Schema from 'effect/Schema'

/**
 * Tenant sandbox surface. Every endpoint runs behind
 * {@link OrganizationAuthentication}, so handlers receive a resolved member
 * instead of decoding transport headers themselves.
 */
export class SandboxesApiGroup extends HttpApiGroup.make('sandboxes')
  .add(
    HttpApiEndpoint.get('list', '/sandboxes')
      .addSuccess(Schema.Array(SandboxSummarySchema))
      .addError(ForbiddenError),
  )
  .middleware(OrganizationAuthentication) {}
