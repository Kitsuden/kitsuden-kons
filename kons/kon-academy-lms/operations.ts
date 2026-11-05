/**
 * The academy's routes as kon SDK operations
 * ============================================================================
 *
 * The router registered its handlers in a `Hono` with
 * `academyLMSRoutes.get(path, ...middlewares, handler)`. Now it registers
 * OPERATIONS with the same shape: `app.get(path, declaration, handler)`,
 * where the declaration (id, schemas, access, permission, errors) replaces the
 * middlewares and the handler is still the same —it receives the
 * Hono context `c`—.
 *
 * This way each route's body does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, OpenAPI,
 * the MCP tool and the fine-grained scope `kon:academy-lms:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import type { z } from "zod";

export const KON_ID = "kon-academy-lms";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:courseId/:userId/:supervisorId/:code";

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
    delete: add("DELETE"),
  };
}

/**
 * The routes that used to ask only for a session (the whole router's `requireAuth`).
 * People all get in; an AGENT, only with the host's usual rule
 * (`agent-as-user.ts`): `user:act`, `admin` or some
 * academy scope. SDK operations do not go through that rule.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "academy", action: "actAsUser" },
} as const;

/**
 * The former `requireRole(["administrator", "supervisor"])`: the policy's
 * `manage` action (global admin, academy administrator or supervisor). It is
 * checked BEFORE validating the body, as before.
 */
export const MANAGE = { policy: { resource: "academy", action: "manage" } } as const;

/** The former `requireRole(["administrator"])`: the `administer` action. */
export const ADMINISTER = { policy: { resource: "academy", action: "administer" } } as const;

/** Serial operations: the request runs in ONE transaction (no `Promise.all`). */
export async function inSeries<T, R>(
  elements: readonly T[],
  fn: (element: T) => Promise<R>
): Promise<R[]> {
  const outputValue: R[] = [];
  for (const element of elements) outputValue.push(await fn(element));
  return outputValue;
}

/**
 * What `zValidator("json", schema)` from `@hono/zod-validator` answered, which
 * is how these routes validated the body: 400 with the zod result
 * as is (`{ success: false, error }`) and unknown fields silently STRIPPED
 * (except in `.strict()` schemas, which reject them with that 400).
 *
 * That is why these operations declare `validatesHandler: true`: the SDK publishes the
 * schema (OpenAPI, MCP) but does not apply it —its 422 would change the status, and its
 * rejection of extra fields would break the client that sends them today—. With no body,
 * `zValidator` validated `{}`: the same is done here.
 */
export async function validatedAsBefore<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
  rawValue: unknown
): Promise<z.output<T> | Response> {
  const result = await schema.safeParseAsync(rawValue === undefined ? {} : rawValue);
  if (!result.success) return c.json(result, 400);
  return result.data;
}
