import { consoleRoutes } from '@fissionplane/core/frontend/routes'
import { Link, useParams } from 'react-router'

export const Component = () => {
  const { sandboxId } = useParams()

  return (
    <main className="mx-auto max-w-7xl p-6">
      <Link className="text-sm underline" to={consoleRoutes.sandboxes}>
        Back to sandboxes
      </Link>
      <p className="mt-8 text-xs tracking-widest text-muted-foreground uppercase">
        Sandbox
      </p>
      <h1 className="mt-2 font-heading text-4xl font-semibold">
        {sandboxId ?? 'Unknown sandbox'}
      </h1>
    </main>
  )
}
