import { Button as ButtonPrimitive } from '@base-ui/react/button'
import { cn } from '@fissionplane/console-web/lib/utils'
import { cva, type VariantProps } from 'class-variance-authority'

const buttonVariants = cva(
  'inline-flex h-10 items-center justify-center rounded-none border px-6 text-xs font-semibold tracking-widest uppercase transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    defaultVariants: {
      variant: 'default',
    },
    variants: {
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground hover:bg-primary/80',
        outline:
          'border-border bg-transparent hover:bg-muted hover:text-foreground',
      },
    },
  },
)

export const Button = ({
  className,
  variant,
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) => (
  <ButtonPrimitive
    className={cn(buttonVariants({ className, variant }))}
    {...props}
  />
)
