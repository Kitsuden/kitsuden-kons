/**
 * Booking's routes as kon SDK operations
 * ============================================================================
 *
 * The router registered its handlers in a `Hono` with
 * `app.get(path, ...middlewares, handler)`. Now it registers OPERATIONS with the
 * same shape: `app.get(path, declaration, handler)`, where the declaration
 * (id, schemas, access, permission, errors) replaces the middlewares and the
 * handler is still the same —it receives the Hono context `c`—.
 *
 * This way each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, OpenAPI,
 * the MCP tool and the fine-grained scope `kon:booking:<id>` come from.
 *
 * ── WHY THERE IS NO `actAsUser` HERE ───────────────────────────────
 *
 * Other kons (esports, broadcast) add the `actAsUser` action to their
 * "any account" operations, because the host's `requireAuth` used to open them
 * —which lets an AGENT through only as an account
 * with `user:act`, `admin` or a kon scope— and SDK operations
 * skip that rule. Booking never went through that `requireAuth`: what that rule
 * does here is the host's GATE (`/api/booking`, `role: "session"`
 * in auth-guard.ts), which runs BEFORE the kon's router marks the
 * request as an SDK operation, and therefore keeps applying it just the same. Repeating it
 * in the kon would change what the kon answers on its own (an agent without a kon
 * scope sees "its" bookings: none; tests/unit/effective-agents-in-kons.test.ts).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-booking";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:blackoutId";

/** A handler of the old kind, with the validated input and the operation's context. */
export type Handler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variables are set by the host
  c: Context<any, KonPath>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each operation brings its own schemas
  input: ValidatedInput<any, any, any>,
  h: OperationContext
) => unknown;

/** A registry of operations shaped like a router. */
export function registry() {
  const ops: AnyOperation[] = [];
  const add =
    (method: KonOperation["method"]) =>
    (route: string, declaration: Declaration, handle: Handler): void => {
      ops.push(
        defineOperation({
          ...declaration,
          method,
          route,
          handle: (input, h) => handle(h.c, input, h),
        })
      );
    };
  return {
    ops,
    get: add("GET"),
    post: add("POST"),
    put: add("PUT"),
    patch: add("PATCH"),
    delete: add("DELETE"),
  };
}

/**
 * Managing rooms, services and blocks: the STAFF (`manage` of
 * "booking-room": admin or editor, or an agent with the whole kon). It is checked
 * BEFORE the body (phase D fixes, 2026-10-25): with validation
 * first, an account without permission got a 422 for an empty body and learned
 * the schema of a route that is not theirs. It was the `managesRooms` middleware.
 */
export const MANAGES_ROOMS = {
  policy: { resource: "booking-room", action: "manage" },
} as const;

/**
 * The same, but checked INSIDE the handler, after validating the body:
 * it is the order `PATCH /rooms/:id` had (without `managesRooms`), and it is not
 * changed when migrating. The handler calls `h.authorize({ isActive: true }, "manage")`.
 */
export const MANAGES_ROOMS_IN_HANDLER = {
  policy: { resource: "booking-room", action: "manage", inHandler: true },
} as const;
