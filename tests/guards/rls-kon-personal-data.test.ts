/**
 * RLS for the personal data of kon-members and kon-newsletter
 * ============================================================================
 *
 * Real Postgres (PGlite) and a NON-superuser role, like `kitsuden_app`
 * in production: with a superuser the policies filter nothing and the test
 * would be decorative (see the RLS enforcement caveats).
 *
 * The context is set the same way as `withTransactionalRLS()`: `set_config(…, true)`
 * inside a transaction, with `anonymous` for someone without a session.
 *
 * Security review.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

let pg: PGlite;

const read = (route: string) =>
  readFileSync(resolve(__dirname, "../../kons", route), "utf8");

/** Counts rows of `table` as a request with that context would. */
async function count(table: string, ctx: { id: string; role: string } | null): Promise<number> {
  await pg.exec("BEGIN; SET LOCAL ROLE app_prueba;");
  try {
    if (ctx) {
      await pg.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.id]);
      await pg.query("SELECT set_config('app.current_user_role', $1, true)", [ctx.role]);
    }
    const r: any = await pg.query(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0].n;
  } finally {
    await pg.exec("ROLLBACK;");
  }
}

async function insertAs(sqlText: string, ctx: { id: string; role: string }): Promise<boolean> {
  await pg.exec("BEGIN; SET LOCAL ROLE app_prueba;");
  try {
    await pg.query("SELECT set_config('app.current_user_id', $1, true)", [ctx.id]);
    await pg.query("SELECT set_config('app.current_user_role', $1, true)", [ctx.role]);
    await pg.exec(sqlText);
    return true;
  } catch {
    return false;
  } finally {
    await pg.exec("ROLLBACK;");
  }
}

const ANONYMOUS = { id: "", role: "anonymous" };
const USER = { id: "u-cualquiera", role: "user" };
const EDITOR = { id: "u-editor", role: "editor" };
const ADMIN = { id: "u-admin", role: "admin" };

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(read("kon-members/migrations/0001_members.sql"));
  await pg.exec(read("kon-newsletter/migrations/0000_initial.sql"));

  // The OWNERSHIP policy that rls-owned-tables.sql puts on nl_members (by
  // user_id), as is: it is the one that let an anonymous with context through.
  await pg.exec(`
    ALTER TABLE nl_members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY nl_members_owner_isolation ON nl_members FOR ALL TO PUBLIC
      USING (
        current_setting('app.current_user_id', true) = ''
        OR current_setting('app.current_user_id', true) IS NULL
        OR current_setting('app.current_user_role', true) = 'admin'
        OR user_id::text = current_setting('app.current_user_id', true)
      );
  `);

  await pg.exec(`
    INSERT INTO members (id, email) VALUES ('m1', 'lectora@example.com'), ('m2', 'otro@example.com');
    INSERT INTO member_sessions (id, member_id, token_hash, expires_at) VALUES ('s1', 'm1', 'h', now() + interval '1 day');
    INSERT INTO member_signins (id, member_id, token_hash, expires_at) VALUES ('g1', 'm1', 'h2', now() + interval '1 hour');
    INSERT INTO nl_members (email, status, unsub_token, user_id) VALUES ('sub@example.com', 'subscribed', 'tok', 'u-cualquiera');
    INSERT INTO nl_suppressions (email, reason) VALUES ('baja@example.com', 'unsubscribe');
  `);

  // The new migrations, twice: they have to be idempotent.
  for (let i = 0; i < 2; i++) {
    await pg.exec(read("kon-members/migrations/0002_personal_data_rls.sql"));
    await pg.exec(read("kon-newsletter/migrations/0001_personal_data_rls.sql"));
  }

  await pg.exec(`
    CREATE ROLE app_prueba NOLOGIN;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_prueba;
  `);
});

afterAll(async () => {
  await pg?.close();
});

describe("members: the email base", () => {
  test("the system (kon routes, no context) sees everything", async () => {
    expect(await count("members", null)).toBe(2);
    expect(await count("member_sessions", null)).toBe(1);
  });

  test("a normal account and an anonymous with context see NOTHING", async () => {
    expect(await count("members", USER)).toBe(0);
    expect(await count("members", ANONYMOUS)).toBe(0);
    expect(await count("member_access", USER)).toBe(0);
  });

  test("the team sees the members but NOT the sessions or the links", async () => {
    expect(await count("members", EDITOR)).toBe(2);
    expect(await count("members", ADMIN)).toBe(2);
    expect(await count("member_sessions", ADMIN)).toBe(0);
    expect(await count("member_signins", ADMIN)).toBe(0);
  });

  test("a normal account cannot write itself a session or an access", async () => {
    expect(
      await insertAs(
        "INSERT INTO member_sessions (id, member_id, token_hash, expires_at) VALUES ('s9', 'm2', 'x', now() + interval '1 day')",
        USER
      )
    ).toBe(false);
    expect(
      await insertAs(
        "INSERT INTO member_access (id, member_id, tier_id, source) VALUES ('a9', 'm2', 'tier_free', 'manual')",
        USER
      )
    ).toBe(false);
  });
});

describe("newsletter: subscribers, suppressions and unsubscribe tokens", () => {
  test("the system sees everything", async () => {
    expect(await count("nl_members", null)).toBe(1);
    expect(await count("nl_suppressions", null)).toBe(1);
  });

  test("an anonymous with context no longer gets through the ownership policy", async () => {
    // Without the restrictive one, `current_user_id = ''` opened up all of nl_members.
    expect(await count("nl_members", ANONYMOUS)).toBe(0);
    expect(await count("nl_suppressions", ANONYMOUS)).toBe(0);
  });

  test("neither a normal account (even if the row is theirs) nor the editor", async () => {
    expect(await count("nl_members", USER)).toBe(0);
    expect(await count("nl_members", EDITOR)).toBe(0);
    expect(await count("nl_deliveries", USER)).toBe(0);
  });

  test("admin does", async () => {
    expect(await count("nl_members", ADMIN)).toBe(1);
  });
});
