/**
 * The inbox's operations, under the CRM's mount (`/api/crm/inbox/…`) and fine scopes (`kon:crm:<id>`)
 * ============================================================================
 *
 * A registry of their own and not the CRM's (operations.ts): the CRM's wraps every answer in the access dials
 * (amounts, notes, sensitive fields), which are about the CRM's records. Mail has its own rule, row security on
 * the owner (migrations/0015_inbox.sql), and a person needs no CRM access to sync their own mailbox.
 */

import { defineOperation, type AnyOperation } from "@kitsuden/engine";
import type { OperationContext, ValidatedInput, KonOperation } from "@kitsuden/shared";
import type { Context } from "hono";


/** What is declared for an operation: everything except method, path and handler. */
export type Declaration = Omit<KonOperation, "method" | "route" | "handle">;

/**
 * The path parameters of the kon's routes. With this path as a type,
 * `c.req.param("…")` is `string` — as when each route typed its own — and not
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

/** A person (or an agent acting as one) on their own mailboxes; row security keeps them apart. */
export const OWN = { policy: { resource: "crm-inbox", action: "actAsUser" } } as const;

/** Sending as the person: their own mailbox, and for an agent a proposal (`sensitive`). */
export const SEND = { policy: { resource: "crm-inbox", action: "send" } } as const;
