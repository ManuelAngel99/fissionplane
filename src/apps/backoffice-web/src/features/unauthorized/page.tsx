import { backofficeRoutes } from '@fissionplane/core/frontend/routes'
import { Link } from 'react-router'

export const Component = () => (
  <main className="grid min-h-svh place-items-center p-6 text-center">
    <div>
      <p className="font-heading text-5xl font-semibold">Access denied</p>
      <p className="mt-4 text-muted-foreground">
        This account is not a platform administrator.
      </p>
      <Link
        className="mt-6 inline-block text-sm underline"
        to={backofficeRoutes.signIn}
      >
        Return to sign in
      </Link>
    </div>
  </main>
)
