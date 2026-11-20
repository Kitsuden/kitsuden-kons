/**
 * Kon error response: never internal details to the client.
 * ============================================================================
 *
 * Before, the routes returned `messageOf(err)` as is: the Postgres text
 * (table, constraint and column names, the value that did not match) or that
 * of any service exception reached the browser. Here:
 *
 *   · `AppError` (validation, 404, 403…) goes out with its message, which was written
 *     for the client.
 *   · Postgres errors that are the REQUEST's fault (duplicate key,
 *     reference to something that does not exist, text that is not a UUID) go out as
 *     409/400 with a generic message and WITHOUT the engine's detail.
 *   · Anything else: generic 500, and the detail only to the log.
 */

import { AppError, respondError } from "@kitsuden/engine";
import type { Context } from "hono";

/** The Postgres error inside `err` (drizzle wraps it in `cause`), if there is one. */
function postgresError(err: unknown): { code: string; detail?: string } | undefined {
  let actual: unknown = err;
  for (let i = 0; i < 4 && actual && typeof actual === "object"; i++) {
    const code = (actual as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const detail = (actual as { detail?: unknown }).detail;
      return { code, detail: typeof detail === "string" ? detail : undefined };
    }
    actual = (actual as { cause?: unknown }).cause;
  }
  return undefined;
}

function postgresCode(err: unknown): string | undefined {
  return postgresError(err)?.code;
}

/** By name and shape, not by `instanceof`: two copies of the engine do not share a class. */
function isAppError(err: unknown): err is AppError {
  return (
    err instanceof Error &&
    err.name === "AppError" &&
    typeof (err as { status?: unknown }).status === "number"
  );
}

export function translateError(err: unknown): unknown {
  if (isAppError(err)) return err;
  switch (postgresCode(err)) {
    case "23505":
      return AppError.conflict("A record with that data already exists");
    case "23503":
      // The same code covers both directions of a foreign key. Deleting a
      // record that others still point at (a client with projects or
      // invoices) said «It refers to a record that does not exist», the
      // opposite of what happened. The detail only goes to the branch, never out.
      if (/is still referenced/i.test(postgresError(err)?.detail ?? "")) {
        return AppError.conflict("Other records still use it: remove or reassign them first");
      }
      return AppError.badRequest("It refers to a record that does not exist");
    case "22P02":
    case "22007":
    case "22008":
      return AppError.badRequest("Invalid data format");
    case "23514":
    case "23502":
      return AppError.badRequest("Incomplete or out-of-range data");
    case "42501":
      // RLS or database permissions: for the client it is the same as not existing.
      return AppError.notFound("Not found");
    default:
      return err;
  }
}

export function respondWithError(err: unknown, c: Context, origin: string): Response {
  const translated = translateError(err);
  // Hono HTTPException (malformed JSON, body too large…): it is a
  // 4xx with a message meant for the client.
  const status = (translated as { status?: unknown })?.status;
  if (!isAppError(translated) && typeof status === "number" && status >= 400 && status < 500) {
    return respondError(c, translated);
  }
  if (!isAppError(translated)) {
    console.error(`[${origin}] unhandled error:`, err);
    return respondError(c, AppError.internal());
  }
  return respondError(c, translated);
}
