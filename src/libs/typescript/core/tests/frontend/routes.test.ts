import {
  backofficeRoutes,
  CONSOLE_SANDBOX_ID_PARAM,
  consoleRoute,
  consoleRoutes,
} from '@fissionplane/core/frontend/routes'
import { describe, expect, it } from 'vitest'

describe('frontend route catalogs', () => {
  it('builds encoded sandbox detail URLs under the list route', () => {
    expect(consoleRoute.sandbox('sandbox/with spaces')).toBe(
      '/sandboxes/sandbox%2Fwith%20spaces',
    )
  })

  it('keeps the detail pattern and the detail builder on one path', () => {
    expect(consoleRoutes.sandboxPattern).toBe(
      `${consoleRoutes.sandboxes}/:${CONSOLE_SANDBOX_ID_PARAM}`,
    )
    expect(consoleRoute.sandbox('abc')).toBe(
      consoleRoutes.sandboxPattern.replace(
        `:${CONSOLE_SANDBOX_ID_PARAM}`,
        'abc',
      ),
    )
  })

  it('keeps tenant and operator sign-in routes explicit', () => {
    expect(consoleRoutes.signIn).toBe('/sign-in')
    expect(backofficeRoutes.signIn).toBe('/sign-in')
    expect(backofficeRoutes.unauthorized).toBe('/unauthorized')
  })
})
