import { Button } from '@fissionplane/console-web/components/ui/button'
import { SandboxEmptyState } from '@fissionplane/console-web/features/sandboxes/components/sandbox-empty-state'
import { useSandboxes } from '@fissionplane/console-web/features/sandboxes/hooks/use-sandboxes'
import { useHealth } from '@fissionplane/console-web/features/system/hooks/use-health'

export const Component = () => {
  const health = useHealth()
  const sandboxes = useSandboxes()

  return (
    <main className="mx-auto max-w-7xl p-6">
      <div className="flex items-end justify-between">
        <div>
          <p className="text-xs tracking-widest text-muted-foreground uppercase">
            Organization console
          </p>
          <h1 className="mt-2 font-heading text-4xl font-semibold">
            Sandboxes
          </h1>
        </div>
        <Button>Create sandbox</Button>
      </div>
      <section className="mt-8 border border-border bg-background">
        <div className="grid grid-cols-[1fr_auto] border-b border-border p-4 text-xs tracking-widest uppercase">
          <span>Environment</span>
          <span>API {health.data?.status ?? health.status}</span>
        </div>
        {sandboxes.data?.length === 0 ? <SandboxEmptyState /> : null}
      </section>
    </main>
  )
}
