/**
 * The collection routes as kon SDK operations
 * ============================================================================
 *
 * The router used to register its handlers on a `Hono` with
 * `app.get(path, ...middlewares, handler)`. Now it registers OPERATIONS with the
 * same shape: `app.get(path, declaration, handler)`, where the declaration
 * (id, schemas, access, permission, errors) replaces the middlewares and the
 * handler is still the same as always — it receives the Hono context `c`.
 *
 * So each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, the
 * OpenAPI, the MCP tool and the fine-grained scope `kon:collection:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-collection";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as a type,
 * `c.req.param("…")` is `string` — as when each route typed its own — and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:datasetId";

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
 * The routes with no check beyond the session (read and empty MY collection).
 * People all get in; an AGENT only with the usual host rule
 * for `requireAuth` (`agent-as-user.ts`): `user:act`,
 * `admin` or some scope of the kon. SDK operations do not go through that
 * rule, so the policy repeats it (`actAsUser`).
 */
export const ANY_ACCOUNT = {
  policy: { resource: "collection", action: "actAsUser" },
} as const;

/** Mark: the policy's `create` action, with the asker's mark. */
export const MARK = {
  policy: { resource: "collection", action: "create", inHandler: true },
} as const;
