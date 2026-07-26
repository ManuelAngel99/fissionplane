import type { Health, ServiceName } from '@fissionplane/core/system/types'

export interface GetHealthInput {
  readonly service: ServiceName
}

export type GetHealthResult = Health
