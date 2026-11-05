/**
 * OCR Training routes as kon SDK operations
 * ============================================================================
 *
 * Each route used to be registered on a `Hono` with `router.get(path, requireAuth,
 * exigir(action), handler)`. Now it registers OPERATIONS with the same shape:
 * `app.get(path, declaration, handler)`, where the declaration (id,
 * schemas, access, permission, errors) replaces the middlewares and the handler
 * stays the same as ever —it receives the Hono context `c`—.
 *
 * So the body of each route does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where the OpenAPI, the
 * MCP tool and the fine-grained scope `kon:ocr-training:<id>` come from.
 *
 * The `/yomi/*` proxy is NOT an operation: it forwards any method to
 * any allowed engine sub-route, and that does not fit a declared
 * contract. It stays as a legacy route (`legacyRoutes` of `defineKonSdk`).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-ocr-training";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("jobId")` is `string` and not `string | undefined`.
 */
export type KonPath = "/:jobId";

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
 * What used to be `requireAuth` + `require(action)`: the "ocr-training" policy
 * (administration only), checked BEFORE reading anything, as before. It already asks for
 * more than «having a session», so the host's agent rule
 * (`actAsUser`) need not be repeated here: an agent passes with `admin` or
 * with the action's scope, just as with `can()`.
 */
export const adminOnly = (action: "operate" | "configure") =>
  ({ policy: { resource: "ocr-training", action } }) as const;
