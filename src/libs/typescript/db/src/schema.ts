import { generateNanoId } from '@fissionplane/core/shared/identifiers'
import { pgSchema, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

export const tenantAuth = pgSchema('tenant_auth')
export const backofficeAuth = pgSchema('backoffice_auth')

export const organizationLinks = tenantAuth.table(
  'catalog_organization_link',
  {
    id: text('id').$defaultFn(generateNanoId).primaryKey(),
    authOrganizationId: text('auth_organization_id').notNull(),
    catalogOrganizationId: text('catalog_organization_id').notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('catalog_organization_link_auth_id_unique').on(
      table.authOrganizationId,
    ),
    uniqueIndex('catalog_organization_link_catalog_id_unique').on(
      table.catalogOrganizationId,
    ),
  ],
)

export const operatorProfiles = backofficeAuth.table(
  'operator_profile',
  {
    id: text('id').$defaultFn(generateNanoId).primaryKey(),
    authUserId: text('auth_user_id').notNull(),
    createdAt: timestamp('created_at', {
      mode: 'date',
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('operator_profile_auth_user_id_unique').on(table.authUserId),
  ],
)

export const databaseSchema = {
  operatorProfiles,
  organizationLinks,
}
