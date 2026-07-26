import { CubeIcon } from '@phosphor-icons/react'

export const SandboxEmptyState = () => (
  <div className="grid min-h-80 place-items-center text-center">
    <div>
      <CubeIcon className="mx-auto size-8" />
      <h2 className="mt-4 font-heading text-lg font-semibold">
        No sandboxes yet
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Create a sandbox to run code in an isolated environment.
      </p>
    </div>
  </div>
)
