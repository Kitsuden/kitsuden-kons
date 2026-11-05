/**
 * The wiki's routes as kon SDK operations
 * ============================================================================
 *
 * The router used to register its handlers on a `Hono` with
 * `app.get(path, ...middlewares, handler)`. Now it registers OPERATIONS with the
 * same shape: `app.get(path, declaration, handler)`, where the declaration
 * (id, schemas, access, permission, errors) replaces the middlewares and the
 * handler is still the same —it receives the Hono context `c`—.
 *
 * That way the body of each route does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, OpenAPI,
 * the MCP tool and the fine-grained scope `kon:wiki:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

export const KON_ID = "kon-wiki";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as a type,
 * `c.req.param("…")` is `string` — as when each route typed its own — and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:wiki/:slug/:from/:to/:number";

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
 * The policy with the page already loaded (or the one for creating a wiki): the handler
 * calls `h.can(...)` after validating and loading, as before the SDK.
 */
export const onThePage = {
  policy: { resource: "wiki", action: "update", inHandler: true },
} as const;
export const onTheWikis = {
  policy: { resource: "wiki-space", action: "create", inHandler: true },
} as const;

// ── Common schemas ───────────────────────────────────────────────────────────
//
// Outputs are lax on purpose (`passthrough`): they are database rows, which
// grow column by column. What a client needs to continue is pinned down.

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);
