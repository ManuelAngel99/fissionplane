import {
  accessControl,
  organizationRoles,
} from '@fissionplane/core/organizations/permissions'
import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  plugins: [
    organizationClient({
      ac: accessControl,
      roles: organizationRoles,
    }),
  ],
})

export const ensureActiveOrganization = async (): Promise<boolean> => {
  const session = await authClient.getSession()
  if (session.data === null) {
    return false
  }
  if (session.data.session.activeOrganizationId !== null) {
    return true
  }

  const organizations = await authClient.organization.list()
  const firstOrganization = organizations.data?.[0]
  if (firstOrganization === undefined) {
    return false
  }

  const result = await authClient.organization.setActive({
    organizationId: firstOrganization.id,
  })
  return result.error === null
}
