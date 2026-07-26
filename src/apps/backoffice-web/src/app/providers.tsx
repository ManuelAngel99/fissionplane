import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
    },
  },
})

export const AppProviders = ({
  children,
}: {
  readonly children: ReactNode
}) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
