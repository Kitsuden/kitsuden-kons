/**
 * Calls to the kon's REST routes with the browser's cookies, like the rest of the admin: the view
 * never holds a token, so every rule of the kon (membership, roles) applies to it as well.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** `?a=1&b=2` without the empty values. */
export function qs(query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function createApi(base: () => string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base() + path, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const d = data as { error?: { message?: string; code?: string } | string; message?: string } | null;
      const error = typeof d?.error === "object" ? d.error : undefined;
      const message = error?.message || d?.message || (typeof d?.error === "string" ? d.error : "") || `HTTP ${res.status}`;
      throw new ApiError(message, res.status, error?.code);
    }
    return data as T;
  }

  return {
    get: <T>(path: string, query?: Query) => call<T>("GET", path + qs(query)),
    post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
    patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
    del: <T>(path: string, query?: Query) => call<T>("DELETE", path + qs(query)),
  };
}

export type Api = ReturnType<typeof createApi>;

/** A path segment from an id or an issue key. */
export const seg = (v: string) => encodeURIComponent(v);
