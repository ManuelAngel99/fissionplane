import { healthQuery } from '@fissionplane/backoffice-web/features/overview/api'
import { useQuery } from '@tanstack/react-query'

export const usePlatformHealth = () => useQuery(healthQuery)
