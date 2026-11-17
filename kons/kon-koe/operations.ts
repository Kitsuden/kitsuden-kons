/**
 * kon-koe's operations registry
 * ============================================================================
 *
 * Same shape as a router (`app.get(path, declaration, handler)`), where the declaration gives the validation,
 * the OpenAPI, the MCP tool and the fine-grained scope `kon:koe:<id>`. Each module adds its operations to the
 * same registry (index.ts lists them).
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { KonContext, KonOperation, OperationContext, ValidatedInput } from "@kitsuden/shared";
import type { Context } from "hono";
import { z } from "@kitsuden/engine/zod";

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

export type Registry = ReturnType<typeof registry>;

/** A module's contribution: it adds its operations to the registry. */
export type OperationsModule = (app: Registry, ctx: KonContext) => void;

export const Output = z.object({}).passthrough();
export const ParamId = z.object({ id: z.string().min(1).max(100).describe("Row id") });
