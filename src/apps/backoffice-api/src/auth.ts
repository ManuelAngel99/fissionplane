import { config } from '@fissionplane/backoffice-api/config'
import { createDatabase } from '@fissionplane/db/client'
import { betterAuth } from 'better-auth'
import { admin } from 'better-auth/plugins'

const { pool } = createDatabase({
  connectionString: config.databaseUrl,
  schema: 'backoffice_auth',
})

export const auth = betterAuth({
  appName: 'FissionPlane Backoffice',
  baseURL: config.baseUrl,
  database: pool,
  emailAndPassword: {
    disableSignUp: true,
    enabled: true,
  },
  plugins: [
    admin({
      adminRoles: ['admin'],
      defaultRole: 'user',
    }),
  ],
  secret: config.authSecret,
  trustedOrigins: config.trustedOrigins,
})
