/**
 * Calls to the kon's REST routes with the browser's cookies, like the rest of the admin: the view
 * never holds a token, so the kon's rules (tournament staff, roles) apply to it as well.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The parsed response, for routes that explain themselves (`issues` of a phase plan). */
    readonly payload: unknown
  ) {
    super(message);
  }
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
      const d = data as { error?: { message?: string } | string; message?: string } | null;
      const error = typeof d?.error === "object" ? d.error : undefined;
      const message =
        error?.message || (typeof d?.error === "string" ? d.error : "") || d?.message || `HTTP ${res.status}`;
      throw new ApiError(message, res.status, data);
    }
    return data as T;
  }

  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body?: unknown) => call<T>("POST", path, body),
    del: <T>(path: string) => call<T>("DELETE", path),
  };
}

export type Api = ReturnType<typeof createApi>;

/** A path segment from an id. */
export const seg = (v: string) => encodeURIComponent(v);

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
