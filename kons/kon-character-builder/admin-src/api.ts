/**
 * Calls to the kon's REST routes with the browser's cookies, like the rest of the admin: the view
 * never holds a token. The error shown is the server's own reason (a 422 says "the option is in
 * two slots"), never a generic "could not save".
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

export function createApi(base: () => string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(base() + path, {
      method,
      credentials: "include",
      headers: { "content-type": "application/json" },
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
      const message =
        (typeof d?.error === "string" ? d.error : d?.error?.message) || d?.message || `HTTP ${res.status}`;
      throw new ApiError(message, res.status);
    }
    return (data ?? {}) as T;
  }

  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  };
}

export type Api = ReturnType<typeof createApi>;

export const seg = (v: string) => encodeURIComponent(v);
