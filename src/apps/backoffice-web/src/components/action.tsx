import type { ReactNode } from 'react'

export const Action = ({
  children,
  onClick,
  type = 'button',
}: {
  readonly children: ReactNode
  readonly onClick?: () => void
  readonly type?: 'button' | 'submit'
}) => (
  <button
    className="inline-flex h-10 items-center justify-center gap-2 border border-primary bg-primary px-5 font-heading text-xs font-semibold tracking-widest text-primary-foreground uppercase hover:opacity-80"
    onClick={onClick}
    type={type}
  >
    {children}
  </button>
)
