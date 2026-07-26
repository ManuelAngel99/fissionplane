import { AuthenticatedLayout } from '@fissionplane/backoffice-web/app/layouts/authenticated-layout'
import { RouteError } from '@fissionplane/backoffice-web/app/route-error'
import { authClient } from '@fissionplane/backoffice-web/lib/auth-client'
import { backofficeRoutes } from '@fissionplane/core/frontend/routes'
import { createBrowserRouter, redirect } from 'react-router'

const requireAdministrator = async () => {
  const session = await authClient.getSession()
  if (session.data === null) {
    return redirect(backofficeRoutes.signIn)
  }
  if (session.data.user.role !== 'admin') {
    return redirect(backofficeRoutes.unauthorized)
  }
  return null
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    lazy: () => import('@fissionplane/backoffice-web/features/auth/page'),
    path: backofficeRoutes.signIn,
  },
  {
    lazy: () =>
      import('@fissionplane/backoffice-web/features/unauthorized/page'),
    path: backofficeRoutes.unauthorized,
  },
  {
    children: [
      {
        index: true,
        loader: () => redirect(backofficeRoutes.overview),
      },
      {
        lazy: () =>
          import('@fissionplane/backoffice-web/features/overview/page'),
        path: backofficeRoutes.overview,
      },
      {
        lazy: () =>
          import('@fissionplane/backoffice-web/features/organizations/page'),
        path: backofficeRoutes.organizations,
      },
      {
        lazy: () =>
          import('@fissionplane/backoffice-web/features/sandboxes/page'),
        path: backofficeRoutes.sandboxes,
      },
    ],
    Component: AuthenticatedLayout,
    errorElement: <RouteError />,
    loader: requireAdministrator,
    path: backofficeRoutes.root,
  },
])
