import { defineConfig } from 'drizzle-kit'

const databaseUrl = process.env.DATABASE_URL

if (databaseUrl === undefined) {
  throw new Error('DATABASE_URL is required to run Drizzle migrations')
}

export default defineConfig({
  dialect: 'postgresql',
  dbCredentials: {
    url: databaseUrl,
  },
  out: './migrations',
  schema: './src/schema.ts',
  schemaFilter: ['backoffice_auth', 'tenant_auth'],
  strict: true,
  verbose: true,
})
