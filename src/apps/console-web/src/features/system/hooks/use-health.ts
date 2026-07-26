import { healthQuery } from '@fissionplane/console-web/features/system/api'
import { useQuery } from '@tanstack/react-query'

export const useHealth = () => useQuery(healthQuery)
