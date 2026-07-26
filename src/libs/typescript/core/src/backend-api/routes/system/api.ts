import { HealthSchema } from '@fissionplane/core/system/types'
import * as HttpApiEndpoint from '@effect/platform/HttpApiEndpoint'
import * as HttpApiGroup from '@effect/platform/HttpApiGroup'

/** Console liveness surface. Reuses the domain health schema unchanged. */
export class SystemApiGroup extends HttpApiGroup.make('system').add(
  HttpApiEndpoint.get('health', '/health').addSuccess(HealthSchema),
) {}
