import { backofficeRoutes } from '@fissionplane/core/frontend/routes'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router'

export const RouteError = () => {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : 'An unexpected error occurred'

  return (
    <main className="grid min-h-svh place-items-center p-6">
      <div className="max-w-lg border bg-card p-8">
        <p className="text-xs tracking-widest text-muted-foreground uppercase">
          FissionPlane Backoffice
        </p>
        <h1 className="mt-4 font-heading text-3xl font-semibold">
          Something went wrong
        </h1>
        <p className="mt-4 text-sm text-muted-foreground">{message}</p>
        <Link
          className="mt-6 inline-block text-sm underline"
          to={backofficeRoutes.root}
        >
          Return to backoffice
        </Link>
      </div>
    </main>
  )
}
