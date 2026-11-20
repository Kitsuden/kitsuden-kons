/**
 * kon-crm: the lists that stopped at a cap, or returned every row, can be read a page at a time
 * ============================================================================
 *
 * `list-deal-documents` takes an optional `limit` (without it, every row as before);
 * `list-suppressions`, `list-targets`, `list-merge-requests`, `list-portal-links` and
 * `list-score-model-versions` keep their old cap as the default `limit`. All answer `hasMore`.
 *
 * `list-work`, `list-observations`, `list-inbound-emails`, `list-threads` and `list-events` took
 * a `limit` with no way past it. They keep that `limit` and its default and take `offset`, with
 * `hasMore`; rows that tie on the sort key are ordered by id, so pages neither repeat nor skip.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { registerInboxPolicy } from "../../kons/kon-crm/crm.inbox.policy";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { ACTORS, dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const STAFF = ACTORS.staff.id;
const json = (res: Response): Promise<any> => res.json();

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('p1', 'P');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('s1', 'p1', 'A', 0);
    INSERT INTO crm_deals (id, title, value, pipeline_id, stage_id, assigned_to) VALUES
      ('d1', 'Claim', 500, 'p1', 's1', '${STAFF}');
    INSERT INTO crm_documents (id, deal_id, name, file_url, uploaded_at) VALUES
      ('doc1', 'd1', 'Older', '/o', now() - interval '1 day'), ('doc2', 'd1', 'Newer', '/n', now());
    INSERT INTO crm_suppressions (kind, value, created_at) VALUES
      ('email', 'a@x.example', now() - interval '1 day'), ('domain', 'y.example', now());
    INSERT INTO crm_sales_targets (id, user_id, period_start, period_end, amount) VALUES
      ('t1', '${STAFF}', '2026-01-01', '2026-03-31', 1000),
      ('t2', '${STAFF}', '2026-04-01', '2026-06-30', 2000);
    -- Three tasks for staff: one due first, then two due the same day and created together.
    INSERT INTO crm_activities (id, type, subject, due_date, assigned_to, created_at) VALUES
      ('task-c', 'task', 'Third', '2026-02-01', '${STAFF}', '2026-01-01T00:00:00Z'),
      ('task-b', 'task', 'Second', '2026-02-01', '${STAFF}', '2026-01-01T00:00:00Z'),
      ('task-a', 'task', 'First', '2026-01-15', '${STAFF}', '2026-01-01T00:00:00Z');
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES ('c1', 'Olga', 'Observed', 'olga@x.example');
    INSERT INTO crm_observations (id, entity_type, entity_id, field, value, source, evidence, weight, status, observed_at) VALUES
      ('obs-1', 'contact', 'c1', 'jobTitle', '"Older"', 'test', 'confirmed-by-person', 100, 'suggested', now() - interval '2 days'),
      ('obs-2', 'contact', 'c1', 'jobTitle', '"Middle"', 'test', 'confirmed-by-person', 100, 'suggested', now() - interval '1 day'),
      ('obs-3', 'contact', 'c1', 'jobTitle', '"Newest"', 'test', 'confirmed-by-person', 100, 'suggested', now());
    INSERT INTO crm_inbound_emails (id, provider, message_id, subject, status, received_at) VALUES
      ('in-1', 'generic', 'm1', 'Older', 'recorded', now() - interval '2 days'),
      ('in-2', 'generic', 'm2', 'Middle', 'recorded', now() - interval '1 day'),
      ('in-3', 'generic', 'm3', 'Newest', 'rejected', now());
    INSERT INTO crm_inbox_mailboxes (id, owner_id, connection_id, provider, address) VALUES
      ('00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'conn-1', 'google', 's@example.com');
    INSERT INTO crm_inbox_threads (id, mailbox_id, owner_id, external_id, subject, last_message_at) VALUES
      ('00000000-0000-4000-8000-00000000bb01', '00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'x1', 'Older', now() - interval '2 days'),
      ('00000000-0000-4000-8000-00000000bb02', '00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'x2', 'Middle', now() - interval '1 day'),
      ('00000000-0000-4000-8000-00000000bb03', '00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'x3', 'Newest', now());
    INSERT INTO crm_inbox_events (id, mailbox_id, owner_id, external_id, title, starts_at) VALUES
      ('00000000-0000-4000-8000-00000000cc01', '00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'e1', 'Soonest', now() + interval '1 day'),
      ('00000000-0000-4000-8000-00000000cc02', '00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'e2', 'Next', now() + interval '2 days'),
      ('00000000-0000-4000-8000-00000000cc03', '00000000-0000-4000-8000-00000000aa01', '${STAFF}', 'e3', 'Latest', now() + interval '3 days');
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCrmPolicy();
  registerInboxPolicy();
});

describe("a deal's documents", () => {
  it("limit=1 gives the newest and says there are more", async () => {
    const page = await json(await request("staff", "GET", "/deals/d1/documents?limit=1"));
    expect(page.data.map((d: any) => d.name)).toEqual(["Newer"]);
    expect(page.hasMore).toBe(true);
    const next = await json(await request("staff", "GET", "/deals/d1/documents?limit=1&offset=1"));
    expect(next.data.map((d: any) => d.name)).toEqual(["Older"]);
    expect(next.hasMore).toBe(false);
  });

  it("without limit, every document as before, and hasMore false", async () => {
    const all = await json(await request("staff", "GET", "/deals/d1/documents"));
    expect(all.data).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  it("a limit out of range is refused", async () => {
    const res = await request("staff", "GET", "/deals/d1/documents?limit=501");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});

describe("lists that had a hidden cap", () => {
  it("the exclusion list pages, newest first", async () => {
    const page = await json(await request("staff", "GET", "/suppressions?limit=1"));
    expect(page.data.map((s: any) => s.value)).toEqual(["y.example"]);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("staff", "GET", "/suppressions"));
    expect(all.data).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  it("sales targets page, newest period first", async () => {
    const page = await json(await request("staff", "GET", "/targets?limit=1"));
    expect(page.data.map((t: any) => t.id)).toEqual(["t2"]);
    expect(page.hasMore).toBe(true);
    const all = await json(await request("staff", "GET", "/targets"));
    expect(all.data).toHaveLength(2);
    expect(all.hasMore).toBe(false);
  });

  it("the empty lists say there is nothing more", async () => {
    for (const route of ["/merge-requests", "/score-model/versions"]) {
      const body = await json(await request("staff", "GET", route));
      expect(body.hasMore).toBe(false);
    }
    const links = await json(await request("staff", "GET", "/portal-links"));
    expect(links.data).toEqual([]);
    expect(links.hasMore).toBe(false);
  });
});

describe("lists that had a limit and no way past it", () => {
  /** Without offset, the old answer (plus hasMore); limit=1 and offset=1 walk it one row at a time. */
  async function walks(actor: "staff" | "admin", route: string, label: (row: any) => string, expected: string[]) {
    const sep = route.includes("?") ? "&" : "?";
    const all = await json(await request(actor, "GET", route));
    expect(all.data.map(label)).toEqual(expected);
    expect(all.hasMore).toBe(false);

    const first = await json(await request(actor, "GET", `${route}${sep}limit=1`));
    expect(first.data.map(label)).toEqual([expected[0]]);
    expect(first.hasMore).toBe(true);

    const second = await json(await request(actor, "GET", `${route}${sep}limit=1&offset=1`));
    expect(second.data.map(label)).toEqual([expected[1]]);
    expect(second.hasMore).toBe(true);

    const last = await json(await request(actor, "GET", `${route}${sep}limit=2&offset=2`));
    expect(last.data.map(label)).toEqual([expected[2]]);
    expect(last.hasMore).toBe(false);
  }

  it("the work queue: most urgent first, ties by id, and total still counts every task", async () => {
    await walks("staff", "/work", (t) => t.id, ["task-a", "task-b", "task-c"]);
    const page = await json(await request("staff", "GET", "/work?limit=1&offset=1"));
    expect(page.total).toBe(3);
  });

  it("observations, newest first", async () => {
    await walks("staff", "/observations", (o) => o.id, ["obs-3", "obs-2", "obs-1"]);
  });

  it("inbound emails, newest first, still with setup", async () => {
    await walks("admin", "/inbound-emails", (e) => e.id, ["in-3", "in-2", "in-1"]);
    const page = await json(await request("admin", "GET", "/inbound-emails?limit=1&offset=1"));
    expect(page.setup).toBeDefined();
  });

  it("inbox threads, newest first", async () => {
    await walks("staff", "/inbox/threads", (t) => t.subject, ["Newest", "Middle", "Older"]);
  });

  it("calendar events, soonest first", async () => {
    await walks("staff", "/inbox/events", (e) => e.title, ["Soonest", "Next", "Latest"]);
  });

  it("a negative offset is refused", async () => {
    for (const route of ["/work", "/observations", "/inbox/threads"]) {
      const res = await request("staff", "GET", `${route}?offset=-1`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
  });
});
