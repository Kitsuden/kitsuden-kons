/**
 * VekStudio routes (/api/ocr) as kon SDK operations
 * ============================================================================
 *
 * Each route used to be registered on a `Hono` with `router.get(path, requireAuth,
 * …, handler)`. Now it registers OPERATIONS with the same shape:
 * `app.get(path, declaration, handler)`, where the declaration (id,
 * schemas, access, permission, errors) replaces the middlewares and the handler
 * stays the same as ever —it receives the Hono context `c`—.
 *
 * So the body of each route does not change when moving to the SDK (docs/kons/README.md):
 * what changes is what is DECLARED, which is where the OpenAPI, the
 * MCP tool and the fine-grained scope `kon:vekstudio:<id>` come from.
 *
 * The `/gateway/*` proxy is NOT an operation: it forwards any method to
 * any allowed gateway sub-route (multipart uploads, the SSE flow of
 * `/events`), and that does not fit a declared contract. It remains a legacy route
 * (`legacyRoutes` of `defineKonSdk`).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-vekstudio";

/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as the type,
 * `c.req.param("jobId")` is `string` and not `string | undefined`.
 */
export type KonPath = "/:jobId";

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

/** What used to be `requireAuth` + `require("submit")`: the team, BEFORE reading anything. */
export const TEAM_ONLY = { policy: { resource: "vekstudio", action: "submit" } } as const;

/**
 * The routes on ONE document. Before: `requireAuth`, then the 404 if the id
 * is invalid or does not exist, and only then `can(view|edit)` on the row (which
 * also responds 404, so as not to confirm which jobs exist). That order is not
 * changed when migrating:
 *
 *   · before the handler, the host's rule for agents
 *     (`actAsUser`: what its `requireAuth` did, which the SDK does not
 *     apply to its operations);
 *   · in the handler, after loading the row, `h.can(doc, "view" | "edit")`
 *     (the policy plus the fine-grained `kon:vekstudio:<id>` scopes).
 */
export const ON_THE_DOCUMENT = {
  policy: { resource: "vekstudio", action: "actAsUser" },
} as const;
