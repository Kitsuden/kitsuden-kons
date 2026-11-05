/** Display helpers for the queue. */

/** Short, readable date. No library: it is one line. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Link to the commented content.
 *
 * The map is local on purpose: the public route depends on the site, not on the panel, and
 * guessing it from the `subjectType` with a rule ("strip the suffix, add a slash") is where
 * "Agregar All Gam" came from.
 */
export function link(type: string, slug: string | null | undefined): string {
  const routes: Record<string, string> = { blog_post: "/blog/", block_page: "/" };
  return `${routes[type] ?? "/"}${encodeURIComponent(slug ?? "")}`;
}

/** `textContent`-safe by construction: Svelte escapes it. The name is written by anyone who comments. */
export const author = (name: string | null | undefined) => name || "anonymous";
