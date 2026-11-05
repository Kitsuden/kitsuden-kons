/**
 * The store routes as kon SDK operations
 * ============================================================================
 *
 * Each route used to be registered on a `Hono` with `shop.get(path, handler)` (and the
 * panel behind a `shop.use("/admin/*", requireAuth)`). Now it registers
 * OPERATIONS with the same shape: `shop.get(path, declaration, handler)`,
 * where the declaration (id, schemas, access, permission, errors) replaces
 * the middlewares and the handler is still the same as always — it receives the
 * Hono context `c`.
 *
 * So each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where the OpenAPI, the
 * MCP tool and the fine-grained scope `kon:ecommerce:<id>` come from.
 */

import { AppError, defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-ecommerce";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as a type,
 * `c.req.param("id")` is `string` — as when each route typed its own — and not
 * `string | undefined`.
 */
export type KonPath = "/:id/:slug/:item";

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
 * The panel policies that do NOT look at the resource (`isTeam`/`isAdmin`), and
 * that used to be checked with `authorize(user, action, { id: "*" }, type)`
 * BEFORE reading the body: the SDK checks them at the same point.
 */
export const policy = (resource: "shop-product" | "shop-order" | "shop-promotion", action: string) =>
  ({ policy: { resource, action } }) as const;

/**
 * The panel routes on ONE product, variant or order. Before: the prefix's
 * `requireAuth`, then the 404 if the id does not exist, and only
 * then `authorize` on the loaded row. That order is what the authorization
 * matrix measures (any account "gets in" with an id that does not exist), and
 * it is not changed on migrating:
 *
 *   · before the handler, the host's rule for agents
 *     (`actAsUser`: what its `requireAuth` did, which the SDK does not
 *     apply to its operations);
 *   · in the handler, after loading the row, `require(h, row, action, type)`.
 */
export const onTheRow = (resource: "shop-product" | "shop-order" | "shop-promotion") =>
  ({ policy: { resource, action: "actAsUser" } }) as const;

/**
 * The policy on the already loaded row, with the SAME response that
 * `authorize()` gave (AppError 403 `Not authorized for '<action>' on <type>`).
 * `h.can` is the policy plus the SDK's fine-grained scopes (`kon:ecommerce:<id>`).
 */
export async function require(
  h: OperationContext,
  row: unknown,
  action: string,
  type: "shop-product" | "shop-order" | "shop-promotion"
): Promise<void> {
  if (await h.can(row, action)) return;
  if (!h.user) throw AppError.unauthenticated();
  throw AppError.forbidden(`Not authorized to '${action}' on ${type}`);
}
