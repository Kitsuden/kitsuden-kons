/**
 * The Conta routes as kon SDK operations
 * ============================================================================
 *
 * The router used to register its handlers on a `Hono` with
 * `app.get(path, ...middlewares, handler)` and the gates with
 * `app.use("/*", ...)`. Now it registers OPERATIONS with the same shape:
 * `app.get(path, declaration, handler)`, where the declaration (id, schemas,
 * access, permission, errors) replaces the middlewares and the handler is still
 * the same as always — it receives the Hono context `c`.
 *
 * So each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, the
 * OpenAPI and the MCP tool come from.
 *
 * ── WHY THERE IS NO `actAsUser` HERE ───────────────────────────────
 *
 * Other kons (esports, broadcast) add the `actAsUser` action to their
 * "any account" operations, because they used to be opened only by the host's
 * `requireAuth` — which lets an AGENT through as an account with
 * `user:act`, `admin` or a kon scope — and SDK operations
 * skip that rule. In Conta there are NO "any account" operations: all of them
 * (except the public front page) ask for an action of the "conta" policy (`view`,
 * `write`, `administer`), which is more than that rule: an agent without
 * `conta:<action>`, `conta:*`, `admin` or the operation's fine scope `kon:conta:<operation>` does
 * not pass, whether or not it brings `user:act`.
 * The host's gate (auth-guard.ts) does not cover `/api/conta` either: the kon
 * authorizes itself.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-conta";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:userId/:accountId";

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

/** The actions of the "conta" policy (conta.policy.ts). */
export type ContaAction = "view" | "write" | "administer";

/**
 * Each action's declared permission. The SDK checks it BEFORE validating the
 * body (like the old middleware), with the conta role that the router's `before`
 * (`withContaRole`) leaves on the user: the policy reads it from there when it
 * does not arrive in the resource.
 */
export const CONTA_PERMISSION = {
  view: { policy: { resource: "conta", action: "view" } },
  write: { policy: { resource: "conta", action: "write" } },
  administer: { policy: { resource: "conta", action: "administer" } },
} as const;
