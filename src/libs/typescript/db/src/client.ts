import { databaseSchema } from '@fissionplane/db/schema'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

export type AuthSchema = 'backoffice_auth' | 'tenant_auth'

export interface DatabaseOptions {
  readonly connectionString: string
  readonly schema: AuthSchema
}

export const createDatabase = ({
  connectionString,
  schema,
}: DatabaseOptions) => {
  const pool = new Pool({
    connectionString,
    options: `-c search_path=${schema},public`,
  })

  return {
    database: drizzle(pool, { schema: databaseSchema }),
    pool,
  }
}
