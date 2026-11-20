/**
 * Postgres 23503 in both directions
 * ============================================================================
 *
 * The same code is raised when a row points at something that does not exist
 * (insert) and when a row that others still point at is deleted. Conta, agile
 * and dms answered both with «It refers to a record that does not exist»:
 * deleting a client with invoices said the opposite of what happened. Found by
 * the 2026-11-19 web app test (DELETE /api/conta/counterparties/:id).
 */

import { describe, expect, it } from "vitest";

import { translateError as agile } from "../../kons/kon-agile/http-errors";
import { translateError as conta } from "../../kons/kon-conta/http-errors";
import { translateError as dms } from "../../kons/kon-dms/http-errors";

/** What drizzle throws: its own error with the pg one in `cause`. */
function drizzleError(detail: string) {
  return Object.assign(new Error("Failed query: delete from …"), {
    cause: Object.assign(new Error("violates foreign key constraint"), { code: "23503", detail }),
  });
}

const STILL_REFERENCED = drizzleError(
  'Key (id)=(abc) is still referenced from table "conta_invoices".'
);
const MISSING = drizzleError('Key (client_id)=(abc) is not present in table "conta_counterparties".');

describe.each([
  ["kon-conta", conta],
  ["kon-agile", agile],
  ["kon-dms", dms],
])("%s", (_kon, translateError) => {
  it("deleting a record still in use is a 409 that says so", () => {
    const err = translateError(STILL_REFERENCED) as { status: number; message: string };
    expect(err.status).toBe(409);
    expect(err.message).toMatch(/still use it/);
  });

  it("pointing at a record that does not exist stays a 400", () => {
    const err = translateError(MISSING) as { status: number; message: string };
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/does not exist/);
  });

  it("never lets the table name out", () => {
    for (const e of [STILL_REFERENCED, MISSING]) {
      expect((translateError(e) as Error).message).not.toMatch(/conta_|Key \(/);
    }
  });
});
