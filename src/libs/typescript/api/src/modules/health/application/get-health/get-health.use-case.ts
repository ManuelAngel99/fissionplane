import type {
  GetHealthInput,
  GetHealthResult,
} from '@fissionplane/api/modules/health/application/get-health/get-health.dto'
import { Context, Effect, Layer } from 'effect'

export interface GetHealthUseCasePort {
  readonly execute: (input: GetHealthInput) => Effect.Effect<GetHealthResult>
}

export class GetHealthUseCase extends Context.Tag(
  '@fissionplane/api/GetHealthUseCase',
)<GetHealthUseCase, GetHealthUseCasePort>() {}

export const GetHealthUseCaseLive = Layer.succeed(GetHealthUseCase, {
  execute: ({ service }) =>
    Effect.succeed({
      service,
      status: 'ok',
    }),
})
