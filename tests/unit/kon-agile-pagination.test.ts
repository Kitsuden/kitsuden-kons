/**
 * kon-agile 1.5 — optional pages on the lists that grow, and the kebab-case intake routes
 * ============================================================================
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role (safe-kons-bench), like
 * kon-agile-plane-parity. A list that grows with use takes `limit` (1-500) and `offset`: with
 * `limit` it answers one page and `hasMore`; without it, the whole list as before 1.5 and
 * `hasMore: false`. The issue list, notifications and work queues keep their own `limit` and
 * default and take `offset` with `hasMore`. The `/agile_intakes/:id/*` aliases keep working, marked deprecated, and
 * `/intakes/:intakeId/convert` is their kebab-case twin.
 */

import type { MiddlewareHandler } from "hono";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonAgile } from "../../kons/kon-agile/index";

import { dropToAppRole, migratedBase } from "./helpers/safe-kons-bench";

const PEOPLE = {
  staff: { id: "Ss9zX7cV5bN3mQ1wE2rT4yU6iO8pA0lK", role: "editor" },
  member: { id: "Mm3N5bV7cX9zA1sD2fG4hJ6kL8qW0eRt", role: "user" },
  viewer: { id: "Bw2E4rT6yU8iO0pA1sD3fG5hJ7kL9zXc", role: "user" },
  // An agent member: assigning it an issue queues work and notifies it.
  bot: { id: "agent-page-0000-0000-000000000001", role: "agent", scopes: ["agile:work"] },
} as const;
type Who = keyof typeof PEOPLE;

const HEADER = "x-test-who";
const optionalAuth: MiddlewareHandler = async (c, next) => {
  const who = c.req.header(HEADER) as Who | undefined;
  if (who && who in PEOPLE) c.set("user" as never, { ...PEOPLE[who] } as never);
  await next();
};
const requireAuth: MiddlewareHandler = async (c, next) => {
  const who = c.req.header(HEADER) as Who | undefined;
  if (!who || !(who in PEOPLE)) return c.json({ error: "Unauthorized" }, 401);
  c.set("user" as never, { ...PEOPLE[who] } as never);
  await next();
};
const auth = { requireAuth, optionalAuth, getSession: async () => null };
const events = { emit: () => {}, on: () => {}, off: () => {} };

let client: PGlite;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
let P: string;

async function req(who: Who, method: string, route: string, body?: unknown) {
  const headers: Record<string, string> = { [HEADER]: who };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON answers
async function ok(who: Who, method: string, route: string, body?: unknown, status = 200): Promise<any> {
  const r = await req(who, method, route, body);
  if (r.status !== status) throw new Error(`${method} ${route} as ${who}: ${r.status} ${await r.text()}`);
  return r.json();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON answers
const ids = (docs: any[]) => docs.map((d) => d.id ?? d.userId);

/**
 * The contract of a paged list: no `limit` is the whole list with `hasMore: false`; `limit=1`
 * is its first row with `hasMore: true`; the pages, put together, are the whole list in order.
 */
async function expectPaged(route: string, items = "docs", who: Who = "staff") {
  const all = await ok(who, "GET", route);
  expect(all.hasMore).toBe(false);
  const rows = all[items];
  expect(rows.length).toBeGreaterThanOrEqual(2);

  const sep = route.includes("?") ? "&" : "?";
  const first = await ok(who, "GET", `${route}${sep}limit=1`);
  expect(first[items]).toHaveLength(1);
  expect(first.hasMore).toBe(true);
  expect(ids(first[items])).toEqual(ids(rows.slice(0, 1)));

  const second = await ok(who, "GET", `${route}${sep}limit=1&offset=1`);
  expect(ids(second[items])).toEqual(ids(rows.slice(1, 2)));

  const pages = [];
  for (let offset = 0; ; offset += 1) {
    const page = await ok(who, "GET", `${route}${sep}limit=1&offset=${offset}`);
    pages.push(...page[items]);
    if (!page.hasMore) break;
  }
  expect(ids(pages)).toEqual(ids(rows));

  const rest = await ok(who, "GET", `${route}${sep}limit=500&offset=1`);
  expect(rest.hasMore).toBe(false);
  expect(ids(rest[items])).toEqual(ids(rows.slice(1)));
  return all;
}

beforeAll(async () => {
  client = await migratedBase("kon-agile", [
    "0000_base_schema.sql",
    "0001_members_and_rls.sql",
    "0002_system_without_user.sql",
    "0003_english_names.sql",
    "0004_english_rls.sql",
    "0005_planning_squads_and_agents.sql",
    "0006_attachments_time_github_search.sql",
  ]);
  const db = await dropToAppRole(client);
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never, events: events as never });
  app = host.mount(createKonAgile(ctx));

  P = (await ok("staff", "POST", "/projects", { name: "Paging", identifier: "PAGE" }, 201)).id;
  await ok("staff", "POST", "/projects", { name: "Another", identifier: "ANOT" }, 201);
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.member.id, role: "member" }, 201);
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.viewer.id, role: "viewer" }, 201);
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.bot.id, role: "member", isAgent: true }, 201);
});

afterAll(async () => {
  await client?.close();
});

describe("optional pages", () => {
  test("projects, members, intakes, sprints and epics of a project", async () => {
    await expectPaged("/projects");
    await expectPaged(`/projects/${P}/members`);

    for (const title of ["First idea", "Second idea", "Third idea"]) {
      await ok("member", "POST", `/${P}/intakes`, { title }, 201);
    }
    await expectPaged(`/${P}/intakes`);
    await expectPaged(`/${P}/intakes?status=pending`);

    await ok("staff", "POST", `/${P}/cycles`, { name: "S1", startDate: "2026-01-01", endDate: "2026-01-14" }, 201);
    await ok("staff", "POST", `/${P}/cycles`, { name: "S2", startDate: "2026-01-15", endDate: "2026-01-28" }, 201);
    await expectPaged(`/${P}/cycles`);

    await ok("staff", "POST", `/${P}/modules`, { name: "Epic A" }, 201);
    await ok("staff", "POST", `/${P}/modules`, { name: "Epic B" }, 201);
    await expectPaged(`/${P}/modules`);
  });

  test("comments, sub-issues, an epic's issues and logged time of an issue", async () => {
    const parent = await ok("staff", "POST", `/${P}/issues`, { name: "Parent" }, 201);
    for (const n of [1, 2, 3]) {
      await ok("member", "POST", `/issues/${parent.key}/comments`, { contentHtml: `<p>Comment ${n}</p>` }, 201);
      await ok("staff", "POST", `/${P}/issues`, { name: `Child ${n}`, parentId: parent.id }, 201);
    }
    await expectPaged(`/issues/${parent.key}/comments`);
    await expectPaged(`/issues/${parent.key}/sub-issues`);

    const epic = await ok("staff", "POST", `/${P}/modules`, { name: "Epic with issues" }, 201);
    const children = await ok("staff", "GET", `/issues/${parent.key}/sub-issues`);
    for (const child of children.docs) {
      await ok("staff", "POST", `/modules/${epic.id}/issues`, { issueKey: child.key }, 201);
    }
    await expectPaged(`/modules/${epic.id}/issues`);

    for (const minutes of [10, 20, 30]) {
      await ok("member", "POST", `/issues/${parent.key}/time`, { minutes }, 201);
    }
    const all = await expectPaged(`/issues/${parent.key}/time`);
    expect(all.totalMinutes).toBe(60);
    // A page still reports the minutes of every entry of the issue.
    const page = await ok("staff", "GET", `/issues/${parent.key}/time?limit=1&offset=1`);
    expect(page.docs).toHaveLength(1);
    expect(page.totalMinutes).toBe(60);
  });

  test("the issue list, notifications and work queues keep their own limit and take offset", async () => {
    const own = await ok("staff", "POST", "/projects", { name: "Own limits", identifier: "OWNL" }, 201);
    await ok("staff", "POST", `/projects/${own.id}/members`, { userId: PEOPLE.bot.id, role: "member", isAgent: true }, 201);
    for (const n of [1, 2, 3]) {
      await ok("staff", "POST", `/${own.id}/issues`, { name: `For the bot ${n}`, assigneeId: PEOPLE.bot.id }, 201);
    }
    // No parameters: what these lists answered before (their default limit), now with `hasMore`.
    const issues = await expectPaged(`/${own.id}/issues`);
    expect(issues.docs.map((d: { name: string }) => d.name)).toEqual(["For the bot 1", "For the bot 2", "For the bot 3"]);
    expect(issues.totalDocs).toBe(3);
    await expectPaged(`/${own.id}/issues?search=bot`);

    const notes = await expectPaged("/notifications", "docs", "bot");
    expect(notes.unread).toBeGreaterThanOrEqual(3);
    // `unread` counts every unread notification, not those of the page.
    expect((await ok("bot", "GET", "/notifications?limit=1")).unread).toBe(notes.unread);

    const mine = await expectPaged("/work/mine", "docs", "bot");
    expect(mine.docs.map((w: { issueName: string }) => w.issueName)).toEqual(["For the bot 1", "For the bot 2", "For the bot 3"]);
    await expectPaged("/work/mine?status=all", "docs", "bot");

    const work = await expectPaged(`/${own.id}/work`);
    // The totals per agent count the whole project, not the page.
    const page = await ok("staff", "GET", `/${own.id}/work?limit=1`);
    expect(page.agents).toEqual(work.agents);
    expect(page.agents.find((a: { agentId: string }) => a.agentId === PEOPLE.bot.id).queued).toBe(3);

    // A bad offset is refused (422); a bad limit keeps falling back to the default, as before.
    expect((await req("staff", "GET", `/${own.id}/issues?offset=-1`)).status).toBe(422);
    expect((await ok("staff", "GET", `/${own.id}/issues?limit=abc`)).docs).toHaveLength(3);
  });

  test("a page size out of 1-500 or a negative offset is refused", async () => {
    for (const q of ["limit=0", "limit=501", "limit=abc", "offset=-1"]) {
      const r = await req("staff", "GET", `/${P}/cycles?${q}`);
      expect(r.status, q).toBeGreaterThanOrEqual(400);
      expect(r.status, q).toBeLessThan(500);
    }
  });
});

describe("intake routes in kebab-case", () => {
  test("POST /intakes/:intakeId/convert turns a pending intake into an issue", async () => {
    const intake = await ok("member", "POST", `/${P}/intakes`, { title: "Convert me" }, 201);
    const done = await ok("staff", "POST", `/intakes/${intake.id}/convert`, undefined, 201);
    expect(done.intake).toMatchObject({ id: intake.id, status: "accepted" });
    expect(done.issue.name).toBe("Convert me");
    expect((await req("staff", "POST", `/intakes/${intake.id}/convert`)).status).toBe(409);
  });

  test("the /agile_intakes/:id aliases still work and say they are deprecated", async () => {
    const intake = await ok("member", "POST", `/${P}/intakes`, { title: "Old client" }, 201);
    const r = await req("staff", "POST", `/agile_intakes/${intake.id}/decline`);
    expect(r.status).toBe(200);
    expect(r.headers.get("deprecation")).toBeTruthy();
    expect(r.headers.get("sunset")).toContain("2027");
    expect((await r.json()).status).toBe("declined");

    const other = await ok("member", "POST", `/${P}/intakes`, { title: "Old convert" }, 201);
    const converted = await req("staff", "POST", `/agile_intakes/${other.id}/convert`);
    expect(converted.status).toBe(201);
    expect(converted.headers.get("deprecation")).toBeTruthy();
  });
});
