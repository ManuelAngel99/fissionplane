import { Button } from '@fissionplane/console-web/components/ui/button'
import { createOrganizationSlug } from '@fissionplane/console-web/features/organizations/create-organization-slug'
import { parseOrganizationName } from '@fissionplane/console-web/features/organizations/parse-organization-name'
import { authClient } from '@fissionplane/console-web/lib/auth-client'
import { consoleRoutes } from '@fissionplane/core/frontend/routes'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'

export const Component = () => {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [error, setError] = useState<string>()

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(undefined)

    const organizationName = parseOrganizationName(name)
    if (!organizationName.valid) {
      setError(organizationName.message)
      return
    }

    const result = await authClient.organization.create({
      name: organizationName.value,
      slug: createOrganizationSlug(organizationName.value),
    })
    if (result.error !== null) {
      setError(result.error.message)
      return
    }

    const active = await authClient.organization.setActive({
      organizationId: result.data.id,
    })
    if (active.error !== null) {
      setError(active.error.message)
      return
    }
    await navigate(consoleRoutes.sandboxes, { replace: true })
  }

  return (
    <main className="grid min-h-svh place-items-center bg-muted p-6">
      <form
        className="w-full max-w-md border border-border bg-background p-8"
        onSubmit={submit}
      >
        <p className="text-xs tracking-widest text-muted-foreground uppercase">
          FissionPlane
        </p>
        <h1 className="mt-4 font-heading text-3xl font-semibold">
          Create your organization
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Sandboxes and permissions are scoped to an organization.
        </p>
        <label className="mt-8 grid gap-2 text-sm">
          Organization name
          <input
            className="h-10 border border-input bg-transparent px-3"
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        {error === undefined ? null : (
          <p className="mt-4 text-sm text-destructive">{error}</p>
        )}
        <Button className="mt-6 w-full" type="submit">
          Continue
        </Button>
      </form>
    </main>
  )
}
