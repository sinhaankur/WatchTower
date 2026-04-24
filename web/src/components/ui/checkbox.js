import { jsx as _jsx } from "react/jsx-runtime";
import * as React from "react";
import { cn } from "@/lib/utils";
const Checkbox = React.forwardRef(({ className, ...props }, ref) => (_jsx("input", { type: "checkbox", ref: ref, className: cn("h-4 w-4 rounded border border-primary ring-offset-background cursor-pointer", className), ...props })));
Checkbox.displayName = "Checkbox";
export { Checkbox };
