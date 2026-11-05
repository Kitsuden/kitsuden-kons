/**
 * The DMS routes as kon SDK operations
 * ============================================================================
 *
 * The router used to register its handlers on a `Hono` with
 * `router.get(path, ...middlewares, handler)` behind a
 * `router.use("/*", requireAuth)`. Now it registers OPERATIONS with the same
 * shape: `app.get(path, declaration, handler)`, where the declaration (id,
 * schemas, access, permission, errors) replaces the middlewares and the handler
 * is still the same as always — it receives the Hono context `c`.
 *
 * So each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, the
 * OpenAPI, the MCP tool and the fine-grained scope `kon:dms:<id>` come from.
 *
 * What does NOT change with this: who can do what with EACH document. That is still
 * the `dms_document` policy (dms.acceso.ts), which the handlers ask
 * with `can()` on the loaded document, and the database's RLS.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-dms";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:templateId/:versionId/:fileId/:commentId/:diagramId/:slug/:code";

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
 * ALL the DMS routes asked only for a session (`router.use("/*", requireAuth)`):
 * the rest (view, edit, review… a document; create, folders, audit) is
 * decided by the handler with the `dms_document` policy and the `dms:*` gates, AFTER
 * validating the body. That host `requireAuth` lets an AGENT through only
 * as an account with `user:act`, `admin` or some scope of the kon
 * (`dms:…`, `kon:dms:…`; agent-as-user.ts), and SDK operations
 * skip that rule. So the policy's `actAsUser` action repeats it,
 * checked BEFORE validating, like the old `requireAuth`.
 *
 * The host's gate (`ADMIN_ONLY_ROUTES` in auth-guard.ts) only covers in
 * `/api/dms` file upload and download (admin only): the rest of the kon
 * depends on this. On those two it is declared anyway — it is weaker than the gate,
 * so it changes nothing — so they stay closed if the gate is removed.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "dms_document", action: "actAsUser" },
} as const;
