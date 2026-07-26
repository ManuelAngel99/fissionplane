import { GetHealthUseCaseLive } from '@fissionplane/api/modules/health/application/get-health/get-health.use-case'
import { BackofficeHealthControllerLive } from '@fissionplane/api/modules/health/infrastructure/http/backoffice-health.controller'
import { BackofficeApi } from '@fissionplane/core/backend-api/definition'
import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'

const ControllersLive = BackofficeHealthControllerLive.pipe(
  Layer.provide(GetHealthUseCaseLive),
)

export const BackofficeApiLive = HttpApiBuilder.api(BackofficeApi).pipe(
  Layer.provide(ControllersLive),
)
