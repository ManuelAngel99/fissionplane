import { Action } from '@fissionplane/backoffice-web/components/action'
import { authClient } from '@fissionplane/backoffice-web/lib/auth-client'
import { backofficeRoutes } from '@fissionplane/core/frontend/routes'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

export const SignInForm = () => {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const result = await authClient.signIn.email({ email, password })
    if (result.error !== null) {
      setError(result.error.message)
      return
    }
    await navigate(backofficeRoutes.overview, { replace: true })
  }

  return (
    <form className="w-full max-w-md border bg-card p-8" onSubmit={submit}>
      <p className="font-heading text-xs tracking-widest uppercase">
        FissionPlane · Restricted
      </p>
      <h1 className="mt-8 font-heading text-3xl font-semibold">
        Operator sign in
      </h1>
      <div className="mt-8 grid gap-5">
        <label className="grid gap-2 text-sm">
          Email
          <input
            className="h-10 border bg-transparent px-3"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />
        </label>
        <label className="grid gap-2 text-sm">
          Password
          <input
            className="h-10 border bg-transparent px-3"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>
        {error === undefined ? null : (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <Action type="submit">Sign in</Action>
      </div>
    </form>
  )
}
