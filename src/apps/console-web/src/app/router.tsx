import { AuthenticatedLayout } from '@fissionplane/console-web/app/layouts/authenticated-layout'
import { RouteError } from '@fissionplane/console-web/app/route-error'
import {
  authClient,
  ensureActiveOrganization,
} from '@fissionplane/console-web/lib/auth-client'
import { consoleRoutes } from '@fissionplane/core/frontend/routes'
import { createBrowserRouter, redirect } from 'react-router'

const requireSession = async () => {
  const session = await authClient.getSession()
  if (session.data === null) {
    return redirect(consoleRoutes.signIn)
  }
  return null
}

const requireActiveOrganization = async () => {
  const sessionRedirect = await requireSession()
  if (sessionRedirect !== null) {
    return sessionRedirect
  }
  return (await ensureActiveOrganization())
    ? null
    : redirect(consoleRoutes.onboarding)
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    lazy: () => import('@fissionplane/console-web/features/auth/page'),
    path: consoleRoutes.signIn,
  },
  {
    errorElement: <RouteError />,
    lazy: () =>
      import('@fissionplane/console-web/features/organizations/onboarding-page'),
    loader: requireSession,
    path: consoleRoutes.onboarding,
  },
  {
    children: [
      {
        index: true,
        loader: () => redirect(consoleRoutes.sandboxes),
      },
      {
        lazy: () => import('@fissionplane/console-web/features/sandboxes/page'),
        path: consoleRoutes.sandboxes,
      },
      {
        lazy: () =>
          import('@fissionplane/console-web/features/sandboxes/sandbox-page'),
        path: consoleRoutes.sandboxPattern,
      },
    ],
    Component: AuthenticatedLayout,
    errorElement: <RouteError />,
    loader: requireActiveOrganization,
    path: consoleRoutes.root,
  },
  {
    lazy: () => import('@fissionplane/console-web/features/not-found/page'),
    path: '*',
  },
])
