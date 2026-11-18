/**
 * Calls to koe's REST routes with the browser's cookies, from the admin view and from the inbox: neither
 * holds a token, so every rule of the kon (row-level security, who may configure) applies to them too.
 *
 * A failed call throws an ApiError with the HTTP status, the API's code and its details: koe's 409 on
 * sending says why in `details.koe` (WINDOW_CLOSED, OPTED_OUT…).
 */

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly details: Record<string, unknown> | null
  ) {
    super(message);
  }
  /** koe's reason on a refused send (koe.send.ts), or null. */
  get koe(): string | null {
    const k = this.details?.koe;
    return typeof k === "string" ? k : null;
  }
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function failure(res: Response, data: unknown): ApiError {
  const d = data as { error?: { message?: string; code?: string; details?: Record<string, unknown> } | string; message?: string } | null;
  const error = typeof d?.error === "object" ? d.error : undefined;
  const message = error?.message || d?.message || (typeof d?.error === "string" ? d.error : "") || `HTTP ${res.status}`;
  return new ApiError(message, res.status, error?.code ?? null, (error?.details as Record<string, unknown> | undefined) ?? null);
}

export function createApi(base: () => string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetch(`${base()}/${path}`, {
      method,
      credentials: "include",
      headers: body === undefined || isForm ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
    const data = await parse(res);
    if (!res.ok) throw failure(res, data);
    return data as T;
  }

  return {
    get: <T>(path: string, query?: Query) => call<T>("GET", path + qs(query)),
    post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
    patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
    del: <T>(path: string) => call<T>("DELETE", path),
    /** multipart/form-data (media uploads). */
    upload: <T>(path: string, form: FormData) => call<T>("POST", path, form),
  };
}

export type Api = ReturnType<typeof createApi>;

/** A path segment from an id. */
export const seg = (v: string) => encodeURIComponent(v);
