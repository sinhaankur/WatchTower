import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose Tailwind class names with conflict resolution.
 *
 * `clsx` handles conditional/array/object class inputs; `twMerge` then
 * dedupes conflicting Tailwind utilities (e.g. `px-2 px-4` → `px-4`) so
 * component variants can be overridden by callers without specificity
 * battles. This is the standard shadcn/Radix `cn` and the foundation the
 * primitive components rely on for composable variants.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
