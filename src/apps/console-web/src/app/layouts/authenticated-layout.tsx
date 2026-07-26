import { Button } from '@fissionplane/console-web/components/ui/button'
import { authClient } from '@fissionplane/console-web/lib/auth-client'
import { consoleRoutes } from '@fissionplane/core/frontend/routes'
import { SignOutIcon } from '@phosphor-icons/react'
import { NavLink, Outlet, useNavigate } from 'react-router'

export const AuthenticatedLayout = () => {
  const navigate = useNavigate()

  const signOut = async () => {
    await authClient.signOut()
    await navigate(consoleRoutes.signIn, { replace: true })
  }

  return (
    <div className="min-h-svh bg-muted">
      <header className="flex h-16 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex items-center gap-8">
          <span className="font-heading text-sm font-semibold tracking-widest uppercase">
            FissionPlane
          </span>
          <nav>
            <NavLink
              className={({ isActive }) =>
                isActive
                  ? 'text-sm font-semibold'
                  : 'text-sm text-muted-foreground'
              }
              to={consoleRoutes.sandboxes}
            >
              Sandboxes
            </NavLink>
          </nav>
        </div>
        <Button onClick={signOut} variant="outline">
          <SignOutIcon />
          Sign out
        </Button>
      </header>
      <Outlet />
    </div>
  )
}
