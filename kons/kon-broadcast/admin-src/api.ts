/**
 * Calls to the kon's REST routes with the browser's cookies, like the rest of the admin: the
 * context the host injects never carries a token, so every rule of the kon applies to the view.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** The API base the host gives, `/api` when it gives none. */
export const apiBaseOf = (context?: { apiBase?: string }) => context?.apiBase || "/api";

/** A path segment from an id. */
export const seg = (v: string) => encodeURIComponent(v);

export function createApi(base: () => string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base() + path, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
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
      // The server's reason is shown as is: a draft rejection says WHY (champion already used,
      // burned by Fearless), and that is what the operator needs.
      const d = data as { error?: { message?: string } | string; message?: string } | null;
      const message =
        (typeof d?.error === "string" ? d.error : d?.error?.message) || d?.message || `HTTP ${res.status}`;
      throw new ApiError(message, res.status);
    }
    return data as T;
  }

  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
    patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  };
}

export type Api = ReturnType<typeof createApi>;

export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
