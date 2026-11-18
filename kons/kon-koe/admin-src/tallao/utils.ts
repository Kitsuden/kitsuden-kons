/**
 * tallao — common utilities
 */

type ClassValue = string | false | null | undefined;

/** Joins CSS classes, skipping empty values. */
export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
