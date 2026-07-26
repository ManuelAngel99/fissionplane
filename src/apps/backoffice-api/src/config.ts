const requireEnvironment = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

export const config = {
  authSecret: requireEnvironment('BACKOFFICE_AUTH_SECRET'),
  baseUrl: process.env.BACKOFFICE_API_URL ?? 'http://localhost:3201',
  databaseUrl: requireEnvironment('DATABASE_URL'),
  port: Number(process.env.BACKOFFICE_API_PORT ?? '3201'),
  trustedOrigins: [process.env.BACKOFFICE_WEB_URL ?? 'http://localhost:3200'],
}
