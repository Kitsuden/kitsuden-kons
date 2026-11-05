/**
 * The esports routes as kon SDK operations
 * ============================================================================
 *
 * Each routes file used to register its handlers on a `Hono` with
 * `app.get(path, ...middlewares, handler)`. Now it registers OPERATIONS with the
 * same shape: `app.get(path, declaration, handler)`, where the declaration
 * (id, schemas, access, permission, errors) replaces the middlewares and the
 * handler remains the same as always —it receives the Hono context `c`—.
 *
 * That way the body of each route does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, the
 * OpenAPI, the MCP tool and the fine-grained scope `kon:esports:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-esports";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is truly validated and typed is in `input.params`.
 */
export type KonPath = "/:id/:tournamentId/:matchId/:participantId/:phaseId/:token";

/** A handler like the old ones, with the validated input as an extra. */
export type Handler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variables are set by the host
  c: Context<any, KonPath>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each operation brings its own schemas
  input: ValidatedInput<any, any, any>,
  h: OperationContext
) => unknown;

/**
 * A registry of operations shaped like a router: `prefijo` is where
 * the sub-router used to be mounted (`/players`), and it is prepended to each path.
 */
export function registry(prefix = "") {
  const ops: AnyOperation[] = [];
  const path = (route: string) => (route === "/" ? prefix || "/" : `${prefix}${route}`);
  const add =
    (method: KonOperation["method"]) =>
    (route: string, declaration: Declaration, handle: Handler): void => {
      ops.push(
        defineOperation({
          ...declaration,
          method,
          route: path(route),
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

/** Organization only (the old `requireStaff`): the policy's `manage` action. */
export const ORGANIZATION_ONLY = {
  policy: { resource: "esports", action: "manage" },
} as const;

/**
 * The "any account" routes (register, teams, invitations, the own
 * check-in). People all get in; an AGENT only with the host's usual rule
 * (`agent-as-user.ts`): `user:act`, `admin`
 * or some esports scope. Without this, when moving to the SDK —which does not apply that rule
 * to its operations— any agent key would act here as an account.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "esports", action: "actAsUser" },
} as const;
