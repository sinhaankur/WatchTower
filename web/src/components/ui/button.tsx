import * as React from "react"
import { cn } from "@/lib/utils"

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'outline' | 'ghost' | 'secondary'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', ...props }, ref) => {
    const baseStyles = "inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-semibold ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50"
    
    const variantStyles = {
      default: "border border-slate-800 bg-red-700 text-white shadow-[2px_2px_0_0_#1f2937] hover:bg-red-800",
      outline: "border border-slate-800 bg-white text-slate-800 shadow-[2px_2px_0_0_#1f2937] hover:bg-amber-50",
      ghost: "text-slate-700 hover:bg-amber-50 hover:text-red-800",
      secondary: "border border-slate-800 bg-amber-300 text-slate-900 shadow-[2px_2px_0_0_#1f2937] hover:bg-amber-200",
    }
    
    return (
      <button
        className={cn(baseStyles, variantStyles[variant], "h-10 px-4 py-2", className)}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button }
