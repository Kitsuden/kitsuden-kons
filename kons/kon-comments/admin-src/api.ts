/**
 * Calls to the kon's REST routes with the browser's cookies, like the rest of the admin: the view
 * never holds a token, so every rule of the kon (moderation permission) applies to it as well.
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
  async function call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base()}/${route}`, {
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
      const message =
        (typeof d?.error === "string" ? d.error : d?.error?.message) || d?.message || `HTTP ${res.status}`;
      throw new ApiError(message, res.status);
    }
    return data as T;
  }

  return {
    get: <T>(route: string) => call<T>("GET", route),
    post: <T>(route: string, body: unknown) => call<T>("POST", route, body),
    del: <T>(route: string) => call<T>("DELETE", route),
  };
}

export type Api = ReturnType<typeof createApi>;
