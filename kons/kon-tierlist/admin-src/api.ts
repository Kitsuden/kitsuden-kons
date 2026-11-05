/**
 * Calls to the kon's REST routes (and the two generic ones the editor asks: datasets and the page
 * builder) with the browser's cookies. The host NEVER passes a token.
 */

/**
 * The error carries the status and the body. When it only carried the text, the caller could not
 * tell «it failed» from «this needs you to confirm it», and the warning that syncing deletes
 * hand-made chips read like any ordinary failure.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload: Record<string, unknown>
  ) {
    super(message);
  }
}

function messageOf(payload: Record<string, unknown>, status: number): string {
  const error = payload.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return `HTTP ${status}`;
}

export function createApi(base: () => string) {
  async function call<T>(url: string, method = "GET", body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new ApiError(messageOf(payload ?? {}, res.status), res.status, payload ?? {});
    return payload as T;
  }

  return {
    /** A route of this kon: `templates`, `templates/<slug>/place`… */
    tierlist: <T>(path: string, method?: string, body?: unknown) => call<T>(`${base()}/tierlist/${path}`, method, body),
    /** Any other route of the API, under the same base (`data-sets`, `page-builder/…`). */
    other: <T>(path: string, method?: string, body?: unknown) => call<T>(`${base()}/${path}`, method, body),
  };
}

export type Api = ReturnType<typeof createApi>;

/** A path segment from a slug or an id. */
export const seg = (v: string) => encodeURIComponent(v);
