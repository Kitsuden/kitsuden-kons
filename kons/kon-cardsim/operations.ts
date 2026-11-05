/**
 * CardSim's routes as kon SDK operations
 * ============================================================================
 *
 * The kon used to register its handlers on a `Hono` with `app.get(path, handler)` and
 * the gates in `app.use(prefix, requireAuth | optionalAuth)`. Now it
 * registers OPERATIONS with the same shape: `app.get(path, declaration,
 * handler)`, where the declaration (id, schemas, access, permission, errors)
 * replaces the middlewares and the handler is still the usual one —it receives
 * Hono's context `c`—.
 *
 * That way the body of each route does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where validation, the
 * OpenAPI, the MCP tool and the fine-grained scope `kon:cardsim:<id>` come from.
 *
 * What does NOT change with this: which CARDS each one sees. That is still
 * `viewFor` per seat inside the handlers (see `cardsim.policy.ts`).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "zod";

export const KON_ID = "kon-cardsim";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("id")` is `string` —as when each route typed its own— and not
 * `string | undefined`. What is validated is in `input.params`.
 */
export type KonPath = "/:id/:slug/:code";

/** A handler of the old kind, with the validated input and the operation's context. */
export type Handler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variables are set by the host
  c: Context<any, KonPath>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each operation brings its own schemas
  input: ValidatedInput<any, any, any>,
  h: OperationContext
) => unknown;

/**
 * A registry of operations shaped like a router.
 *
 * `prefix` mounts a block of routes below the kon's own: the showcase (`/showcase`, formerly
 * DeckShow) and the hand generator (`/hands`, formerly HandLab) keep their old relative paths
 * under it (README.md, "Merged from…").
 */
export function registry(prefix = "") {
  const ops: AnyOperation[] = [];
  const add =
    (method: KonOperation["method"]) =>
    (route: string, declaration: Declaration, handle: Handler): void => {
      ops.push(
        defineOperation({
          ...declaration,
          method,
          route: `${prefix}${route}`,
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
 * The routes that used to ask only for a session (`requireAuth`): my decks,
 * creating and playing games, the queue. All people get in; an AGENT only with
 * the usual host rule (`agent-as-user.ts`): `user:act`,
 * `admin` or some cardsim scope. SDK operations do not go through that
 * rule, so the policy's `actAsUser` action repeats it.
 *
 * It is checked BEFORE validating the body, like the old `requireAuth`. What
 * the route asked for AFTER validating (`create` to save a deck or open
 * a room, `update`/`delete` on the loaded deck) is still asked by the
 * handler, now with `h.can(resource, action)`: the same policy plus the
 * operation's fine-grained scopes.
 */
export const ANY_ACCOUNT = {
  policy: { resource: "cardsim", action: "actAsUser" },
} as const;

/**
 * The same "any account" rule for the showcase and the hand generator, on their own policies
 * (`deckshow`, `handlab`), which keep the names they had as separate kons: an agent passes with
 * `user:act`, `admin` or some scope of that family (see `deckshow.policy.ts`, `handlab.policy.ts`).
 * Each route's own rule (`create`, `update`, `delete`, `moderate`) is still asked by the handler
 * AFTER validating and loading the row, with `h.can(resource, action)`.
 */
export const SHOWCASE_ACCOUNT = {
  policy: { resource: "deckshow", action: "actAsUser" },
} as const;
export const HANDS_ACCOUNT = {
  policy: { resource: "handlab", action: "actAsUser" },
} as const;

/** The hand generator's datasets policy, checked in the handler (after validating, or with the dataset loaded). */
export const onTheDataset = (action: "create" | "update" | "delete") =>
  ({ policy: { resource: "handlab", action, inHandler: true } }) as const;

/**
 * Publish the catalog (game and card definitions). The handler asked
 * `can(manageCatalog)` before reading the body: it is a gate that runs before
 * validation, so it moves to the declaration as is.
 */
export const CATALOG = {
  policy: { resource: "cardsim", action: "manageCatalog" },
} as const;

// ── Common schemas (parameters and outputs) ─────────────────────────────────
//
// Path ids are text: an id that does not exist is answered by the handler with
// its 404 (it does not become a 422). Outputs are lax (`passthrough`):
// they are database rows or engine views, which grow field by field.

export const ParamId = z.object({ id: z.string().describe("Id") });
export const ParamSlug = z.object({ slug: z.string().describe("Game slug (from list-games)") });
export const CodeParam = z.object({
  code: z.string().describe("Short room code (case-insensitive)"),
});

/** A database row: it carries `id`, and the rest as is. */
export const Row = z.object({ id: z.string() }).passthrough();
/** An engine view or a report: an object. */
export const Obj = z.record(z.string(), z.unknown());

/** `{ data: … }` and whatever comes with it. */
export const withData = <T extends z.ZodTypeAny>(data: T) =>
  z.object({ data: data }).passthrough();

/** Free-text query: whatever is not declared is ignored, as always. */
export const query = <S extends z.ZodRawShape>(shape: S) => z.object(shape).passthrough();
export const text = (that: string) => z.string().optional().describe(that);
