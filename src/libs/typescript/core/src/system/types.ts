import * as Schema from 'effect/Schema'

/** HTTP hosts that report their own liveness. */
export const ServiceNameSchema = Schema.Literal(
  'backoffice',
  'console-api',
).annotations({
  identifier: 'ServiceName',
  title: 'Service name',
  description: 'Deployable FissionPlane HTTP host answering a liveness probe.',
})
export type ServiceName = typeof ServiceNameSchema.Type

/** Liveness snapshot every FissionPlane HTTP host reports for itself. */
export const HealthSchema = Schema.Struct({
  service: ServiceNameSchema,
  status: Schema.Literal('ok'),
}).annotations({
  identifier: 'Health',
  title: 'Service health',
  description: 'Liveness probe response naming the responding service.',
})
export type Health = typeof HealthSchema.Type
