import { MetricCard } from '@fissionplane/backoffice-web/features/overview/components/metric-card'
import { usePlatformHealth } from '@fissionplane/backoffice-web/features/overview/hooks/use-platform-health'
import { BuildingsIcon, CubeIcon, PulseIcon } from '@phosphor-icons/react'

export const Component = () => {
  const health = usePlatformHealth()

  return (
    <main className="mx-auto max-w-7xl p-6">
      <p className="text-xs tracking-widest text-muted-foreground uppercase">
        Platform operations
      </p>
      <h1 className="mt-2 font-heading text-4xl font-semibold">Overview</h1>
      <div className="mt-8 grid gap-px bg-border md:grid-cols-3">
        <MetricCard
          icon={<PulseIcon />}
          label="Backoffice API"
          value={health.data?.status ?? health.status}
        />
        <MetricCard icon={<BuildingsIcon />} label="Organizations" value="—" />
        <MetricCard icon={<CubeIcon />} label="Active sandboxes" value="—" />
      </div>
    </main>
  )
}
