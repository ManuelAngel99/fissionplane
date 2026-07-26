import { OrganizationRbacServiceLive } from '@fissionplane/api/modules/authorization/domain/services/organization-rbac.service'
import { OrganizationAuthenticationLive } from '@fissionplane/api/modules/authorization/infrastructure/http/organization-authentication.middleware'
import { GetHealthUseCaseLive } from '@fissionplane/api/modules/health/application/get-health/get-health.use-case'
import { ConsoleHealthControllerLive } from '@fissionplane/api/modules/health/infrastructure/http/console-health.controller'
import { ListSandboxesUseCaseLive } from '@fissionplane/api/modules/sandboxes/application/list-sandboxes/list-sandboxes.use-case'
import { SandboxesControllerLive } from '@fissionplane/api/modules/sandboxes/infrastructure/http/sandboxes.controller'
import { EmptySandboxRepositoryLive } from '@fissionplane/api/modules/sandboxes/infrastructure/repositories/empty-sandbox-repository'
import { ConsoleApi } from '@fissionplane/core/backend-api/definition'
import { HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'

const HealthLive = ConsoleHealthControllerLive.pipe(
  Layer.provide(GetHealthUseCaseLive),
)

const SandboxApplicationLive = ListSandboxesUseCaseLive.pipe(
  Layer.provide(EmptySandboxRepositoryLive),
  Layer.provide(OrganizationRbacServiceLive),
)

const SandboxesLive = SandboxesControllerLive.pipe(
  Layer.provide(SandboxApplicationLive),
)

const ControllersLive = Layer.mergeAll(HealthLive, SandboxesLive)

export const ConsoleApiLive = HttpApiBuilder.api(ConsoleApi).pipe(
  Layer.provide(ControllersLive),
  Layer.provide(OrganizationAuthenticationLive),
)
