/**
 * The directory routes as kon SDK operations
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
 * OpenAPI, the MCP tool and the fine-grained scope `kon:directory:<id>` come from.
 *
 * ── WHY THERE IS NO `actAsUser` HERE ───────────────────────────────
 *
 * Other kons (esports, broadcast, agile) add the `actAsUser` action to their
 * "any account" operations, because they used to be opened by the host's
 * `requireAuth` — which lets an AGENT through only as an account
 * with `user:act`, `admin` or a kon scope — and SDK operations
 * skip that rule. The directory never went through that `requireAuth`: what
 * that rule does here is done by the host's GATE (`/api/directory`,
 * `role: "session"` in auth-guard.ts), which runs BEFORE the kon's router
 * marks the request as an SDK operation, and therefore keeps applying it
 * as before. Repeating it in the kon would change what the kon answers on its own (the
 * public record for someone without a session; tests/unit/kon-directory-security).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

export const KON_ID = "kon-directory";

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
 * Manage (HR: the admin or an agent with the whole kon). It is checked BEFORE
 * the body (phase D fixes): with validation first,
 * an account without permission got a 422 for an empty body and learned the schema
 * of a route that is not theirs. It was the `gestiona(type)` middleware.
 */
export const manages = (
  resource: "directory-structure" | "directory-employee" | "directory-document"
) => ({ policy: { resource, action: "manage" } }) as const;

/**
 * Edit a record: HR (`manage`), or the employee themselves the personal parts
 * (`updateSelf`). It is decided INSIDE the handler, with the record loaded and after
 * validating the body — the order `PATCH /employees/:id` had —, with
 * `h.can(entry, action)`.
 */
export const ON_THE_RECORD = {
  policy: { resource: "directory-employee", action: "updateSelf", inHandler: true },
} as const;

// ── Common schemas (parameters and outputs) ─────────────────────────────────
//
// Path ids are text: the handler answers 404 to anything that is not a uuid
// (or, in organizations, it looks it up as a slug). Validating them here would turn that
// 404 into a 422. The query, with `passthrough`: unknown keys were
// ignored. Outputs are lax: database rows and per-viewer projections.

export const EmployeeParam = z.object({ id: z.string().describe("Employee id (uuid)") });
export const DepartmentParam = z.object({ id: z.string().describe("Department id (uuid)") });
export const OrganizationParam = z.object({
  id: z.string().describe("Organization id (uuid) or slug"),
});

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
export const RowList = z.object({ docs: z.array(Row) }).passthrough();
export const ListWithTotal = z
  .object({ docs: z.array(Row), totalDocs: z.number().int() })
  .passthrough();
/** A record projected for whoever looks (public, colleague or full). */
export const Card = z.record(z.string(), z.unknown());
export const Success = z.object({ success: z.literal(true) });

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);
