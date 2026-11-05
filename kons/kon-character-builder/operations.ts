/**
 * The character builder routes as kon SDK operations
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
 * OpenAPI, the MCP tool and the fine-grained scope `kon:character-builder:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

export const KON_ID = "kon-character-builder";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as a type,
 * `c.req.param("slug")` is `string` — as when each route typed its own — and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:slug/:code/:id";

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
 * The "any account" routes (save a build, vote, validate a
 * definition). People all get in; an AGENT only with the usual host
 * rule (`agent-as-user.ts`): `user:act`, `admin`
 * or some scope of the kon. SDK operations do not go through that rule, so
 * the policy repeats it (`actAsUser`).
 */
export const ANY_ACCOUNT = {
  policy: { resource: "builder", action: "actAsUser" },
} as const;

/** The policy with the build or definition already loaded: the handler calls `h.can(...)`. */
export const onTheResource = (action: "update" | "delete" | "publishDefinition") =>
  ({ policy: { resource: "builder", action, inHandler: true } }) as const;

// ── Common schemas ───────────────────────────────────────────────────────────
//
// Outputs are lax on purpose (`passthrough`): they are database rows, which
// grow column by column. What a client needs to continue is pinned down.

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
/** Engine result (stats, decoded build): an object. */
export const Obj = z.record(z.string(), z.unknown());

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);

export const ParamSlug = z.object({ slug: z.string().describe("Builder definition slug") });
export const CodeParam = z.object({ code: z.string().describe("Share code of a build") });
export const ParamBuild = z.object({ id: z.string().describe("Saved build id") });
