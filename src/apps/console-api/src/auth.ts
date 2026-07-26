import { config } from '@fissionplane/console-api/config'
import {
  accessControl,
  organizationRoles,
} from '@fissionplane/core/organizations/permissions'
import { createDatabase } from '@fissionplane/db/client'
import { betterAuth } from 'better-auth'
import { organization } from 'better-auth/plugins'

const { pool } = createDatabase({
  connectionString: config.databaseUrl,
  schema: 'tenant_auth',
})

export const auth = betterAuth({
  appName: 'FissionPlane Console',
  baseURL: config.baseUrl,
  database: pool,
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    organization({
      ac: accessControl,
      roles: organizationRoles,
      teams: {
        enabled: false,
      },
    }),
  ],
  secret: config.authSecret,
  trustedOrigins: config.trustedOrigins,
})
