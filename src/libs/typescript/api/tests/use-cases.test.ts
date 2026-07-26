import {
  OrganizationRbacService,
  OrganizationRbacServiceLive,
} from '@fissionplane/api/modules/authorization/domain/services/organization-rbac.service'
import {
  GetHealthUseCase,
  GetHealthUseCaseLive,
} from '@fissionplane/api/modules/health/application/get-health/get-health.use-case'
import {
  ListSandboxesUseCase,
  ListSandboxesUseCaseLive,
} from '@fissionplane/api/modules/sandboxes/application/list-sandboxes/list-sandboxes.use-case'
import { SandboxRepository } from '@fissionplane/api/modules/sandboxes/domain/repositories/sandbox-repository'
import { AuthenticatedMemberSchema } from '@fissionplane/core/auth/models'
import { ForbiddenError } from '@fissionplane/core/organizations/errors'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

const viewer = Schema.decodeUnknownSync(AuthenticatedMemberSchema)({
  organizationId: 'auth-org-1',
  role: 'viewer',
  userId: 'user-1',
})

describe('application use cases', () => {
  it('delegates sandbox listing to the repository port', async () => {
    let calls = 0
    let scopedOrganizationId: string | undefined
    const repository = Layer.succeed(SandboxRepository, {
      list: ({ organizationId }) => {
        calls += 1
        scopedOrganizationId = organizationId
        return Effect.succeed([])
      },
    })
    const useCase = ListSandboxesUseCaseLive.pipe(
      Layer.provide(repository),
      Layer.provide(OrganizationRbacServiceLive),
    )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const listSandboxes = yield* ListSandboxesUseCase
        return yield* listSandboxes.execute({ subject: viewer })
      }).pipe(Effect.provide(useCase)),
    )

    expect(result).toEqual([])
    expect(calls).toBe(1)
    expect(scopedOrganizationId).toBe('auth-org-1')
  })

  it('denies permissions missing from the organization role', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const rbac = yield* OrganizationRbacService
        return yield* rbac.requirePermission({
          permission: 'sandbox:create',
          subject: viewer,
        })
      }).pipe(Effect.provide(OrganizationRbacServiceLive), Effect.flip),
    )

    expect(result).toBeInstanceOf(ForbiddenError)
    expect(result.permission).toBe('sandbox:create')
  })

  it('returns the requested service health DTO', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const getHealth = yield* GetHealthUseCase
        return yield* getHealth.execute({ service: 'console-api' })
      }).pipe(Effect.provide(GetHealthUseCaseLive)),
    )

    expect(result).toEqual({
      service: 'console-api',
      status: 'ok',
    })
  })
})
