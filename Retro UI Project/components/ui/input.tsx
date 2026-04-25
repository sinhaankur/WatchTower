import * as React from "react"

import { cn } from "@/lib/utils"

type InputProps = React.ComponentProps<"input">

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full border-2 bg-background px-3 py-2 text-base md:text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      ref={ref}
      {...props}
      // Added: Prevent zoom on mobile by ensuring minimum font size
      style={{
        fontSize: typeof window !== "undefined" && window.innerWidth <= 768 ? "16px" : undefined,
        ...props.style,
      }}
    />
  )
})
Input.displayName = "Input"

export { Input }
