/**
 * Game routes as kon SDK operations
 * ============================================================================
 *
 * `games.routes.ts` used to register its handlers on a `Hono` with
 * `gamesRoutes.get(path, ...middlewares, handler)`. Now it registers
 * OPERATIONS with the same shape: `gamesRoutes.get(path, declaration,
 * handler)`, where the declaration (id, schemas, access, permission, errors)
 * replaces the middlewares and the handler stays the same as ever —it receives
 * the Hono context `c`—.
 *
 * So the body of each route does not change when moving to the SDK
 * (docs/kons/README.md): what changes is what is DECLARED, which is where the
 * validation, the OpenAPI, the MCP tool and the fine-grained scope
 * `kon:games:<id>` come from.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

export const KON_ID = "kon-games";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:slug/:blockId";

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
 * The routes that used to require only a session (`requireAuth`). All people
 * get in (the core gate, `auth-guard.ts`, already limits writes to /api/games
 * to the team); an AGENT only gets in under the host's usual rule
 * (`agent-as-user.ts`): `user:act`, `admin` or some games scope.
 * SDK operations do not go through that rule.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "game", action: "actAsUser" },
} as const;

// ── Common schemas ──────────────────────────────────────────────────────────

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
/** `{ docs, totalDocs }` of the lists. */
export const List = z.object({ docs: z.array(Row), totalDocs: z.number() }).passthrough();

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);

/**
 * Path ids are declared as text: an id that does not exist (or is not a uuid)
 * is answered by the handler or the database with 404/400, not by validation
 * with 422.
 */
export const idOf = (that: string) => z.string().describe(that);
