/**
 * Site — host names
 * ============================================================================
 * Pure rules, no imports: a `Host` header or a domain typed in the panel becomes the one key
 * `site_domains` is looked up by.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * `Example.COM:4321.` → `example.com`. Lower case, without the port or the trailing dot. Returns null
 * for anything that is not a host name: a URL with a scheme or a path, an IPv6 literal, a single
 * label other than `localhost`, a label over 63 characters or one that starts or ends with `-`.
 * International names go in their ASCII form (`xn--…`), the form the `Host` header carries.
 */
export function normalizeHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (h === "" || h.includes("/") || h.includes("@") || h.startsWith("[")) return null;
  h = h.replace(/:\d{1,5}$/, "").replace(/\.$/, "");
  if (h === "" || h.length > 253) return null;
  if (h === "localhost") return h;
  const labels = h.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  return h;
}

/**
 * The hosts to try for a request, in order: the host itself, then without a leading `www.`. A site
 * registered as `example.com` also answers `www.example.com`; one registered with `www.` answers
 * only that, so the two can be different sites when someone wants that.
 */
export function hostCandidates(host: string): string[] {
  return host.startsWith("www.") && host.split(".").length > 2 ? [host, host.slice(4)] : [host];
}
