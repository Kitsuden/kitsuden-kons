/**
 * Payments routes as kon SDK operations
 * ============================================================================
 *
 * Each route used to be registered on a `Hono` with `app.get(path, ...middlewares,
 * handler)`. Now it registers OPERATIONS with the same shape:
 * `app.get(path, declaration, handler)`, where the declaration (id, schemas,
 * access, permission, errors) replaces the middlewares and the handler stays
 * the same as ever —it receives the Hono context `c`—.
 *
 * So the body of each route does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where the validation, the
 * OpenAPI, the MCP tool and the fine-grained scope `kon:payments:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-payments";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("provider")` is `string` —as when each route typed its
 * own— and not `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:provider";

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
 * The routes that used to require only a session (`requireAuth`): the status of my
 * subscription. All people get in; an AGENT only under the host's usual rule
 * (`agent-as-user.ts`): `user:act`, `admin`
 * or some payments scope. SDK operations do not go through that rule.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "payments", action: "actAsUser" },
} as const;

/**
 * Billing belongs to ONE person: the policy needs the owner `userId`, so
 * the handler checks it (`h.can({ userId })`), at the same point as
 * before the SDK.
 */
export const onTheirOwn = (action: "checkout" | "portal" | "cancel") =>
  ({ policy: { resource: "payments", action, inHandler: true } }) as const;
