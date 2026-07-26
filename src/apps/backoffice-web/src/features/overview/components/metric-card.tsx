import type { ReactNode } from 'react'

export const MetricCard = ({
  icon,
  label,
  value,
}: {
  readonly icon: ReactNode
  readonly label: string
  readonly value: string
}) => (
  <section className="bg-card p-6">
    <div className="flex items-center gap-2 text-muted-foreground">
      {icon}
      <span className="text-xs tracking-widest uppercase">{label}</span>
    </div>
    <p className="mt-8 font-heading text-4xl">{value}</p>
  </section>
)
