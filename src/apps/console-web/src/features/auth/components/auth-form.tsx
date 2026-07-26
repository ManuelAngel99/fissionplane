import { Button } from '@fissionplane/console-web/components/ui/button'
import { parseUserDisplayName } from '@fissionplane/console-web/features/auth/parse-user-display-name'
import { createOrganizationSlug } from '@fissionplane/console-web/features/organizations/create-organization-slug'
import { parseOrganizationName } from '@fissionplane/console-web/features/organizations/parse-organization-name'
import {
  authClient,
  ensureActiveOrganization,
} from '@fissionplane/console-web/lib/auth-client'
import { consoleRoutes } from '@fissionplane/core/frontend/routes'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

export const AuthForm = () => {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(undefined)

    if (mode === 'sign-in') {
      const result = await authClient.signIn.email({ email, password })
      if (result.error !== null) {
        setError(result.error.message)
        return
      }
      const hasOrganization = await ensureActiveOrganization()
      await navigate(
        hasOrganization ? consoleRoutes.sandboxes : consoleRoutes.onboarding,
        { replace: true },
      )
      return
    }

    const userName = parseUserDisplayName(name)
    if (!userName.valid) {
      setError(userName.message)
      return
    }
    const organizationName = parseOrganizationName(
      `${userName.value}'s Organization`,
    )
    if (!organizationName.valid) {
      setError(organizationName.message)
      return
    }

    const result = await authClient.signUp.email({
      email,
      name: userName.value,
      password,
    })
    if (result.error !== null) {
      setError(result.error.message)
      return
    }

    const organization = await authClient.organization.create({
      name: organizationName.value,
      slug: createOrganizationSlug(organizationName.value),
    })
    if (organization.error !== null) {
      setError(organization.error.message)
      return
    }
    await authClient.organization.setActive({
      organizationId: organization.data.id,
    })
    await navigate(consoleRoutes.sandboxes, { replace: true })
  }

  return (
    <form
      className="w-full max-w-md border border-border bg-background p-8"
      onSubmit={submit}
    >
      <p className="font-heading text-xs tracking-widest uppercase">
        FissionPlane
      </p>
      <h1 className="mt-8 font-heading text-3xl font-semibold">
        {mode === 'sign-in' ? 'Sign in' : 'Create your account'}
      </h1>
      <div className="mt-8 grid gap-5">
        {mode === 'sign-up' ? (
          <label className="grid gap-2 text-sm">
            Name
            <input
              className="h-10 border border-input bg-transparent px-3"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
        ) : null}
        <label className="grid gap-2 text-sm">
          Email
          <input
            className="h-10 border border-input bg-transparent px-3"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="grid gap-2 text-sm">
          Password
          <input
            className="h-10 border border-input bg-transparent px-3"
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {error === undefined ? null : (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <Button type="submit">
          {mode === 'sign-in' ? 'Sign in' : 'Create account'}
        </Button>
        <Button
          onClick={() =>
            setMode((current) =>
              current === 'sign-in' ? 'sign-up' : 'sign-in',
            )
          }
          type="button"
          variant="outline"
        >
          {mode === 'sign-in' ? 'Create an account' : 'Use an existing account'}
        </Button>
      </div>
    </form>
  )
}
