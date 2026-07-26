const requireEnvironment = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`)
  }
  return value
}

export const config = {
  authSecret: requireEnvironment('CONSOLE_AUTH_SECRET'),
  baseUrl: process.env.CONSOLE_API_URL ?? 'http://localhost:3101',
  databaseUrl: requireEnvironment('DATABASE_URL'),
  port: Number(process.env.CONSOLE_API_PORT ?? '3101'),
  trustedOrigins: [process.env.CONSOLE_WEB_URL ?? 'http://localhost:3100'],
}
