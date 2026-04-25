import * as React from "react"
import { cn } from "@/lib/utils"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'secondary'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const baseStyles = "inline-flex items-center justify-center whitespace-nowrap rounded-none text-sm font-bold ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 select-none"
    // transition applied via inline style to use CSS custom property easing
    const transitionStyle = { transition: 'transform var(--dur-fast, 140ms) var(--ease-spring, cubic-bezier(0.34,1.56,0.64,1)), box-shadow var(--dur-fast, 140ms) ease' }

    const variantStyles = {
      default: "border-2 border-slate-800 bg-red-700 text-white shadow-[4px_4px_0_0_#000] hover:shadow-[6px_6px_0_0_#000] hover:-translate-x-[2px] hover:-translate-y-[2px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
      outline: "border-2 border-slate-800 bg-white text-slate-800 shadow-[4px_4px_0_0_#000] hover:shadow-[6px_6px_0_0_#000] hover:-translate-x-[2px] hover:-translate-y-[2px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
      ghost: "text-slate-700 hover:bg-amber-50 hover:text-red-800",
      secondary: "border-2 border-slate-800 bg-amber-300 text-slate-900 shadow-[4px_4px_0_0_#000] hover:shadow-[6px_6px_0_0_#000] hover:-translate-x-[2px] hover:-translate-y-[2px] active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
    }

    return (
      <button
        className={cn(baseStyles, variantStyles[variant], "h-10 px-4 py-2", className)}
        style={variant !== 'ghost' ? transitionStyle : undefined}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
