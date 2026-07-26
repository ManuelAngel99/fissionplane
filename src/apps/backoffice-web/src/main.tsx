import { AppProviders } from '@fissionplane/backoffice-web/app/providers'
import { router } from '@fissionplane/backoffice-web/app/router'
import '@fissionplane/backoffice-web/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'

const root = document.getElementById('root')

if (root === null) {
  throw new Error('Missing #root element')
}

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
