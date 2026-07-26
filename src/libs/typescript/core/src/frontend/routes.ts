/** Name of the sandbox path parameter in {@link consoleRoutes.sandboxPattern}. */
export const CONSOLE_SANDBOX_ID_PARAM = 'sandboxId'

export const consoleRoutes = {
  onboarding: '/onboarding',
  root: '/',
  sandboxPattern: `/sandboxes/:${CONSOLE_SANDBOX_ID_PARAM}`,
  sandboxes: '/sandboxes',
  signIn: '/sign-in',
} as const

export const consoleRoute = {
  sandbox: (sandboxId: string): string =>
    `${consoleRoutes.sandboxes}/${encodeURIComponent(sandboxId)}`,
}

export const backofficeRoutes = {
  organizations: '/organizations',
  overview: '/overview',
  root: '/',
  sandboxes: '/sandboxes',
  signIn: '/sign-in',
  unauthorized: '/unauthorized',
} as const
