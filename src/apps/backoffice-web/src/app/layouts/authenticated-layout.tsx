import { Action } from '@fissionplane/backoffice-web/components/action'
import { authClient } from '@fissionplane/backoffice-web/lib/auth-client'
import { backofficeRoutes } from '@fissionplane/core/frontend/routes'
import { SignOutIcon } from '@phosphor-icons/react'
import { NavLink, Outlet, useNavigate } from 'react-router'

const navigation = [
  { label: 'Overview', to: backofficeRoutes.overview },
  { label: 'Organizations', to: backofficeRoutes.organizations },
  { label: 'Sandboxes', to: backofficeRoutes.sandboxes },
]

export const AuthenticatedLayout = () => {
  const navigate = useNavigate()

  const signOut = async () => {
    await authClient.signOut()
    await navigate(backofficeRoutes.signIn, { replace: true })
  }

  return (
    <div className="min-h-svh">
      <header className="flex h-16 items-center justify-between border-b px-6">
        <div className="flex items-center gap-8">
          <span className="font-heading text-sm font-semibold tracking-widest uppercase">
            FissionPlane Backoffice
          </span>
          <nav className="flex gap-5">
            {navigation.map((item) => (
              <NavLink
                className={({ isActive }) =>
                  isActive
                    ? 'text-sm font-semibold'
                    : 'text-sm text-muted-foreground'
                }
                key={item.to}
                to={item.to}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <Action onClick={signOut}>
          <SignOutIcon />
          Sign out
        </Action>
      </header>
      <Outlet />
    </div>
  )
}
