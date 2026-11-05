/**
 * kon-chat's routes as kon SDK operations
 * ============================================================================
 *
 * Same shape as a router (`app.get(path, declaration, handler)`), where the declaration gives the validation,
 * the OpenAPI, the MCP tool and the fine-grained scope `kon:chat:<id>`.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { KonOperation, OperationContext, ValidatedInput } from "@kitsuden/shared";
import type { Context } from "hono";

export const KON_ID = "kon-chat";

export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

export type Handler = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variables are set by the host
  c: Context<any, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each operation brings its own schemas
  input: ValidatedInput<any, any, any>,
  h: OperationContext
) => unknown;

export function registry() {
  const ops: AnyOperation[] = [];
  const add =
    (method: KonOperation["method"]) =>
    (route: string, declaration: Declaration, handle: Handler): void => {
      ops.push(defineOperation({ ...declaration, method, route, handle: (input, h) => handle(h.c, input, h) }));
    };
  return { ops, get: add("GET"), post: add("POST"), put: add("PUT"), patch: add("PATCH"), delete: add("DELETE") };
}

/** Talk to a team bot: admins and editors. */
export const USE = { policy: { resource: "chat", action: "use" } } as const;

/** Set bots up, give them knowledge, read every conversation: admins. */
export const CONFIGURE = { policy: { resource: "chat", action: "configure" } } as const;
