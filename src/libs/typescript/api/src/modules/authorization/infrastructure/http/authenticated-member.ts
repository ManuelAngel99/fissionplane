import type { AuthenticatedMember } from '@fissionplane/core/auth/models'

/**
 * Internal headers the Better Auth host writes after it resolves a session.
 *
 * They are the only channel the `OrganizationAuthentication` middleware trusts,
 * so every inbound request must be stripped before the host decides whether to
 * write them itself.
 */
export const AUTHENTICATED_MEMBER_HEADERS = {
  organizationId: 'x-fissionplane-auth-organization-id',
  organizationRole: 'x-fissionplane-auth-organization-role',
  userId: 'x-fissionplane-auth-user-id',
} as const

/** Drops any caller-supplied subject headers. Always run this first. */
export const withoutAuthenticatedMember = (request: Request): Request => {
  const headers = new Headers(request.headers)
  let forged = false
  for (const header of Object.values(AUTHENTICATED_MEMBER_HEADERS)) {
    if (headers.has(header)) {
      headers.delete(header)
      forged = true
    }
  }
  return forged ? new Request(request, { headers }) : request
}

/** Replaces the subject headers with the identity the host just resolved. */
export const withAuthenticatedMember = (
  request: Request,
  subject: AuthenticatedMember,
): Request => {
  const headers = new Headers(request.headers)
  headers.set(AUTHENTICATED_MEMBER_HEADERS.userId, subject.userId)
  headers.set(
    AUTHENTICATED_MEMBER_HEADERS.organizationId,
    subject.organizationId,
  )
  headers.set(AUTHENTICATED_MEMBER_HEADERS.organizationRole, subject.role)
  return new Request(request, { headers })
}
