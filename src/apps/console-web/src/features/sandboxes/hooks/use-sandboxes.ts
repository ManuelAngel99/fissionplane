import { sandboxesQuery } from '@fissionplane/console-web/features/sandboxes/api'
import { useQuery } from '@tanstack/react-query'

export const useSandboxes = () => useQuery(sandboxesQuery)
