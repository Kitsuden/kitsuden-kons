/**
 * Autobattler's routes as kon SDK operations
 * ============================================================================
 *
 * The kon registered its handlers in a `Hono` with
 * `app.get(path, ...middlewares, handler)`. Now it registers OPERATIONS with the
 * same shape: `app.get(path, declaration, handler)`, where the declaration
 * (id, schemas, access, permission, errors) replaces the middlewares and the
 * handler is still the same —it receives the Hono context `c`—.
 *
 * This way each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, OpenAPI,
 * the MCP tool and the fine-grained scope `kon:autobattler:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-autobattler";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("slug")` is `string` —as when each route typed its own— and
 * not `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:slug/:kind";

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
 * The routes that used to require a session (`requireAuth`). People all
 * get in; an AGENT, only with the host's usual rule
 * (`agent-as-user.ts`): `user:act`, `admin` or some autobattler
 * scope. SDK operations do not go through that rule, so the policy
 * repeats it (`actAsUser`) and it is checked BEFORE validating,
 * where the host's `requireAuth` checked it.
 *
 * Each route's own rule (`import`, `create`, `delete`, `rank`) is
 * still asked by the handler where it was asked —after validating and, if there is one,
 * after loading the comp—, with `h.can(resource, action)`. Without the first, an
 * agent with only `mcp:connect` would create comps: `create` lets through
 * any user with an id, and what stopped the key was the host.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "autobattler", action: "actAsUser" },
} as const;
