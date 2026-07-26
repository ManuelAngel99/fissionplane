import { consoleRoutes } from '@fissionplane/core/frontend/routes'
import { Link } from 'react-router'

export const Component = () => (
  <main className="grid min-h-svh place-items-center bg-muted p-6">
    <div className="text-center">
      <p className="font-heading text-6xl font-semibold">404</p>
      <p className="mt-4 text-muted-foreground">This page does not exist.</p>
      <Link
        className="mt-6 inline-block text-sm underline"
        to={consoleRoutes.root}
      >
        Return to console
      </Link>
    </div>
  </main>
)
