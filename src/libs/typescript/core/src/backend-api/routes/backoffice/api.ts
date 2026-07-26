import { HealthSchema } from '@fissionplane/core/system/types'
import * as HttpApiEndpoint from '@effect/platform/HttpApiEndpoint'
import * as HttpApiGroup from '@effect/platform/HttpApiGroup'

/**
 * Operator surface. Backoffice administrator authorization is a separate trust
 * domain enforced by the backoffice host; it never reuses tenant roles.
 */
export class BackofficeOperationsApiGroup extends HttpApiGroup.make(
  'operations',
).add(HttpApiEndpoint.get('health', '/health').addSuccess(HealthSchema)) {}
