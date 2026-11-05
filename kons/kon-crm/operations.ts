/**
 * The CRM routes as kon SDK operations
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
 * OpenAPI, the MCP tool and the fine-grained scope `kon:crm:<id>` come from.
 *
 * ── THE KON'S GATE, NOW ON EACH OPERATION ──────────────────────────────────
 *
 * Before, a `crmRoutes.use("*")` asked for a session (401) and the "crm" policy's `view` (GET) or
 * `edit` (everything else) action on ALL routes, before validating the
 * body; the delete and configuration ones asked AFTER, in addition, for `delete` or
 * `configure` (`require`). Now:
 *
 *   · `access: "session"` on all of them (the usual 401);
 *   · `permission` = the policy action that used to close the route (`VIEW`, `EDIT`,
 *     `DELETE`, `CONFIGURE`), checked before the body, as before;
 *   · the `DELETE`/`CONFIGURE` ones also carry `before: [requiresEdit]`: the
 *     gate asked for `edit` BEFORE `delete`/`configure`, and an agent with only
 *     `crm:delete` (or with `!crm:edit`) did not pass. Without this, it would.
 *
 * ── WHY THERE IS NO `actAsUser` HERE ───────────────────────────────
 *
 * That action is needed on the "any account" operations (esports,
 * broadcast). Here none is: all of them ask for at least `view` or `edit` of the
 * "crm" policy (team, or an agent with `crm:*`/`kon:crm:*`), which is more than
 * "an account". And the host's gate (`/api/crm`, `role: "staff"` in
 * auth-guard.ts) still sits in front of the router.
 */

import { authorize, defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context, MiddlewareHandler } from "hono";

import { applyAccess, checkWrite } from "./crm.access";
import type { CrmDb } from "./crm.db";

import { userOf } from "./crm.context";

export const KON_ID = "kon-crm";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id";

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
          // Every CRM response goes out through here, REST or MCP, so nobody has to remember the amounts.
          handle: async (input, h) => {
            const db = h.ctx.db.instance as CrmDb;
            await checkWrite(db, declaration.id, input);
            return applyAccess(db, await handle(h.c, input, h));
          },
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

/** Read the portfolio: the team (admin, editor) or an agent with the whole CRM. */
export const VIEW = { policy: { resource: "crm", action: "view" } } as const;

/** Work the portfolio (create, edit, move, activities, documents). */
export const EDIT = { policy: { resource: "crm", action: "edit" } } as const;

/** Delete contacts, companies and deals: admin only. */
export const DELETE = { policy: { resource: "crm", action: "delete" } } as const;

/** Pipelines, stages, stage requirements and entities: admin only. */
export const CONFIGURE = { policy: { resource: "crm", action: "configure" } } as const;

/**
 * The old gate for what is not reading (`edit`), which ran BEFORE
 * `require("delete" | "configure")`. It goes in the `before` of the
 * `DELETE` and `CONFIGURE` operations so that asking for the strong action still
 * also asks for the edit one (see the header).
 */
export const requiresEdit: MiddlewareHandler = async (c, next) => {
  await authorize(userOf(c), "edit", null, "crm");
  await next();
};
