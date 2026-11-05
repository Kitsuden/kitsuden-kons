/**
 * kon-agile 1.3 — agents as teammates, squads and planning
 * ============================================================================
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role (safe-kons-bench).
 *
 * The rule for agents (owner's decision 2026-11-03): an agent writes only on issues assigned to
 * itself; as scrum master of a squad, also on the issues of the squad's members and unassigned
 * ones. It never configures the project nor decides intakes. Checked twice: the route answers 403,
 * and the database refuses the same write made by hand (`agile_agent_reach`).
 *
 * Layout: P is created by `staff` (owner); `member` is member, `viewer` is viewer, `outsider` is in
 * nothing. Agents `devA`, `devB` and `sm` are members (`isAgent`); squad "Core" has `sm` as scrum
 * master and `devA` as its only member.
 */

import type { PGlite } from "@electric-sql/pglite";
import type { MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { createKonAgile } from "../../kons/kon-agile/index";
import { agileShared } from "../../kons/kon-agile/agile.routes";

import { dropToAppRole, migratedBase } from "./helpers/safe-kons-bench";

const PEOPLE = {
  staff: { id: "Ss9zX7cV5bN3mQ1wE2rT4yU6iO8pA0lK", role: "editor" },
  member: { id: "Mm3N5bV7cX9zA1sD2fG4hJ6kL8qW0eRt", role: "user" },
  viewer: { id: "Bw2E4rT6yU8iO0pA1sD3fG5hJ7kL9zXc", role: "user" },
  outsider: { id: "Aq7kL2mP9zX4nT8vB1cD3eF5gH6jK0wQ", role: "user" },
  // Agents arrive as `role: "agent"` with their scopes and their agent id (index.ts of the core).
  devA: { id: "agent-dev-a-0000-0000-000000000001", role: "agent", scopes: ["agile:work"] },
  devB: { id: "agent-dev-b-0000-0000-000000000002", role: "agent", scopes: ["agile:work"] },
  sm: { id: "agent-scrum-0000-0000-000000000003", role: "agent", scopes: ["agile:work"] },
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

let client: PGlite;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
let ctx: ReturnType<typeof createTestKonContext>;
let P: string;
let states: Record<string, string>;

const json = async (r: Response): Promise<any> => r.json();
async function req(who: Who, method: string, route: string, body?: unknown) {
  const headers: Record<string, string> = { [HEADER]: who };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.request(route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function ok(who: Who, method: string, route: string, body?: unknown, status = 200) {
  const r = await req(who, method, route, body);
  if (r.status !== status) throw new Error(`${method} ${route} as ${who}: ${r.status} ${await r.text()}`);
  return json(r);
}
const issue = async (who: Who, body: Record<string, unknown>) => ok(who, "POST", `/${P}/issues`, body, 201);

/** Raw SQL with an actor's RLS context, as the host sets it. */
async function sqlAs<T = Record<string, unknown>>(who: Who, query: string, params: unknown[] = []) {
  const u = PEOPLE[who];
  return client.transaction(async (tx) => {
    await tx.query(
      `select set_config('app.current_user_id', $1, true), set_config('app.current_user_role', $2, true)`,
      [u.id, u.role]
    );
    return (await tx.query<T>(query, params)).rows;
  });
}

beforeAll(async () => {
  client = await migratedBase("kon-agile", [
    "0000_base_schema.sql",
    "0001_members_and_rls.sql",
    "0002_system_without_user.sql",
    "0003_english_names.sql",
    "0004_english_rls.sql",
    "0005_planning_squads_and_agents.sql",
  ]);
  const db = await dropToAppRole(client);
  const host = rlsHost(db, auth);
  ctx = createTestKonContext({ db: host.db as any, auth: auth as any });
  app = host.mount(createKonAgile(ctx));

  P = (await ok("staff", "POST", "/projects", { name: "Plataforma", identifier: "PLAT" }, 201)).id;
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.member.id, role: "member" }, 201);
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.viewer.id, role: "viewer" }, 201);
  for (const a of ["devA", "devB", "sm"] as const) {
    await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE[a].id, role: "member", isAgent: true }, 201);
  }
  const { docs } = await ok("staff", "GET", `/${P}/states`);
  states = Object.fromEntries(docs.map((s: any) => [s.name, s.id]));
  await ok("staff", "POST", `/${P}/squads`, { name: "Core", scrumMasterId: PEOPLE.sm.id, memberIds: [PEOPLE.devA.id] }, 201);
});

afterAll(async () => {
  await client?.close();
});

describe("an agent writes only on its own issues", () => {
  test("it creates an issue for itself, not for others nor unassigned", async () => {
    await issue("devA", { name: "Mine", assigneeId: PEOPLE.devA.id });
    expect((await req("devA", "POST", `/${P}/issues`, { name: "Yours", assigneeId: PEOPLE.member.id })).status).toBe(403);
    expect((await req("devA", "POST", `/${P}/issues`, { name: "Nobody's" })).status).toBe(403);
  });

  test("assigning an issue to an agent queues work and notifies it", async () => {
    const x = await issue("member", { name: "Fix login", assigneeId: PEOPLE.devA.id });
    const { docs } = await ok("devA", "GET", "/work/mine");
    expect(docs.some((w: any) => w.issueKey === x.key && w.trigger === "assigned")).toBe(true);
    const n = await ok("devA", "GET", "/notifications?unread=true");
    expect(n.docs.some((d: any) => d.kind === "assigned" && d.issueKey === x.key)).toBe(true);
  });

  test("it moves its own issue; the state stamps the date and the history records it", async () => {
    const x = await issue("member", { name: "Own work", assigneeId: PEOPLE.devA.id });
    const moved = await ok("devA", "PATCH", `/issues/${x.key}`, { stateId: states["In Progress"] });
    expect(moved.startedAt).toBeTruthy();
    const { docs } = await ok("member", "GET", `/issues/${x.key}/activity`);
    expect(docs.some((a: any) => a.action === "state_changed" && a.actorId === PEOPLE.devA.id)).toBe(true);
  });

  test("someone else's issue: 403 from the route, and the database refuses it by hand too", async () => {
    const y = await issue("member", { name: "Member's", assigneeId: PEOPLE.member.id });
    expect((await req("devA", "PATCH", `/issues/${y.key}`, { priority: "urgent" })).status).toBe(403);
    expect((await req("devA", "POST", `/issues/${y.key}/comments`, { contentHtml: "hi" })).status).toBe(403);
    const rows = await sqlAs("devA", `update agile_issues set priority = 'urgent' where key = $1 returning id`, [y.key]);
    expect(rows).toEqual([]);
    const comment = sqlAs("devA", `insert into agile_comments (issue_id, content_html, created_by) values ($1, 'x', $2)`, [y.id, PEOPLE.devA.id]);
    await expect(comment).rejects.toThrow(/row-level security/);
  });

  test("it hangs sub-issues only from issues in its reach", async () => {
    const theirs = await issue("member", { name: "Member's parent", assigneeId: PEOPLE.member.id });
    const mine = await issue("devA", { name: "My parent", assigneeId: PEOPLE.devA.id });
    expect((await req("devA", "POST", `/${P}/issues`, { name: "x", assigneeId: PEOPLE.devA.id, parentId: theirs.id })).status).toBe(403);
    await issue("devA", { name: "My child", assigneeId: PEOPLE.devA.id, parentId: mine.id });
    expect((await ok("member", "GET", `/issues/${mine.key}`)).subIssuesCount).toBe(1);
  });

  test("an agent outside the squad cannot touch the squad's issues", async () => {
    const x = await issue("member", { name: "Squad work", assigneeId: PEOPLE.devA.id });
    expect((await req("devB", "PATCH", `/issues/${x.key}`, { priority: "low" })).status).toBe(403);
  });

  test("it never configures the project nor decides intakes", async () => {
    expect((await req("devA", "POST", `/${P}/cycles`, { name: "S", startDate: "2026-11-01", endDate: "2026-11-14" })).status).toBe(403);
    expect((await req("devA", "POST", `/${P}/labels`, { name: "agent-label" })).status).toBe(403);
    expect((await req("devA", "POST", `/${P}/squads`, { name: "Mine" })).status).toBe(403);
    const intake = await ok("devA", "POST", `/${P}/intakes`, { title: "Idea" }, 201);
    expect((await req("devA", "POST", `/intakes/${intake.id}/approve`)).status).toBe(403);
    const mine = await issue("devA", { name: "Delete me?", assigneeId: PEOPLE.devA.id });
    expect((await req("devA", "DELETE", `/issues/${mine.key}`)).status).toBe(403);
    const rows = await sqlAs("devA", `insert into agile_labels (project_id, name) values ($1, 'by-hand') returning id`, [P]).catch(
      (e) => String(e)
    );
    expect(String(rows)).toMatch(/row-level security/);
  });

  test("it may save a private view, not a shared one", async () => {
    await ok("devA", "POST", `/${P}/views`, { name: "My queue", filters: { assigneeIds: [PEOPLE.devA.id] } }, 201);
    expect((await req("devA", "POST", `/${P}/views`, { name: "Team", isShared: true })).status).toBe(403);
  });
});

describe("a scrum master agent acts on its squad", () => {
  test("it moves a squad member's issue, but not one of someone outside the squad", async () => {
    const x = await issue("member", { name: "Squad issue", assigneeId: PEOPLE.devA.id });
    await ok("sm", "PATCH", `/issues/${x.key}`, { priority: "high" });
    const y = await issue("member", { name: "Outside", assigneeId: PEOPLE.member.id });
    expect((await req("sm", "PATCH", `/issues/${y.key}`, { priority: "high" })).status).toBe(403);
  });

  test("it creates unassigned or squad issues and assigns only inside the squad", async () => {
    const u = await issue("sm", { name: "To distribute" });
    await ok("sm", "PATCH", `/issues/${u.key}`, { assigneeId: PEOPLE.devA.id });
    const v = await issue("sm", { name: "Another" });
    expect((await req("sm", "PATCH", `/issues/${v.key}`, { assigneeId: PEOPLE.member.id })).status).toBe(403);
    expect((await req("sm", "POST", `/${P}/issues`, { name: "x", assigneeId: PEOPLE.devB.id })).status).toBe(403);
  });

  test("taking it out of the squad takes the reach away", async () => {
    const { docs } = await ok("staff", "GET", `/${P}/squads`);
    const core = docs.find((s: any) => s.name === "Core");
    const x = await issue("member", { name: "Before leaving", assigneeId: PEOPLE.devA.id });
    await ok("staff", "DELETE", `/squads/${core.id}/members/${PEOPLE.devA.id}`);
    expect((await req("sm", "PATCH", `/issues/${x.key}`, { priority: "low" })).status).toBe(403);
    await ok("staff", "POST", `/squads/${core.id}/members`, { userId: PEOPLE.devA.id }, 201);
    await ok("sm", "PATCH", `/issues/${x.key}`, { priority: "low" });
  });
});

describe("hand-offs, mentions and the work queue", () => {
  test("a hand-off reassigns with a note, queues work for the next agent and leaves the reach", async () => {
    const x = await issue("member", { name: "Relay", assigneeId: PEOPLE.devA.id });
    const after = await ok("devA", "POST", `/issues/${x.key}/handoff`, { toUserId: PEOPLE.devB.id, note: "Backend done, UI left" });
    expect(after.assigneeId).toBe(PEOPLE.devB.id);
    const comments = await ok("member", "GET", `/issues/${x.key}/comments`);
    expect(comments.docs.at(-1).contentHtml).toContain("Backend done");
    const work = await ok("devB", "GET", "/work/mine");
    expect(work.docs.some((w: any) => w.issueKey === x.key && w.trigger === "handoff" && w.prompt.includes("UI left"))).toBe(true);
    expect((await req("devA", "PATCH", `/issues/${x.key}`, { priority: "low" })).status).toBe(403);
  });

  test("a mention notifies people and queues work for a mentioned agent; non-members are a 422", async () => {
    const x = await issue("member", { name: "Discuss", assigneeId: PEOPLE.member.id });
    await ok("member", "POST", `/issues/${x.key}/comments`, { contentHtml: "<p>@devB @viewer look</p>", mentions: [PEOPLE.devB.id, PEOPLE.viewer.id] }, 201);
    const n = await ok("viewer", "GET", "/notifications?unread=true");
    expect(n.docs.some((d: any) => d.kind === "mention" && d.issueKey === x.key)).toBe(true);
    const work = await ok("devB", "GET", "/work/mine");
    expect(work.docs.some((w: any) => w.issueKey === x.key && w.trigger === "mention")).toBe(true);
    const bad = await req("member", "POST", `/issues/${x.key}/comments`, { contentHtml: "x", mentions: [PEOPLE.outsider.id] });
    expect(bad.status).toBe(422);
    await ok("viewer", "POST", "/notifications/read-all");
    expect((await ok("viewer", "GET", "/notifications")).unread).toBe(0);
  });

  test("an agent claims and closes its own work with its cost; not someone else's", async () => {
    const { docs } = await ok("devB", "GET", "/work/mine");
    const w = docs[0];
    expect((await req("devA", "POST", `/work/${w.id}/claim`)).status).toBe(403);
    await ok("devB", "POST", `/work/${w.id}/claim`);
    expect((await req("devB", "POST", `/work/${w.id}/claim`)).status).toBe(409);
    const done = await ok("devB", "POST", `/work/${w.id}/finish`, { status: "done", result: "UI shipped", inputTokens: 1200, outputTokens: 300, costUsd: 0.0125 });
    expect(done.status).toBe("done");
    const project = await ok("staff", "GET", `/${P}/work?agentId=${PEOPLE.devB.id}`);
    const totals = project.agents.find((a: any) => a.agentId === PEOPLE.devB.id);
    expect(totals).toMatchObject({ done: 1, inputTokens: 1200, outputTokens: 300 });
    expect(totals.costUsd).toBeCloseTo(0.0125);
  });

  test("a schedule wakes an agent once per interval, however many ticks run", async () => {
    await ok("staff", "POST", `/${P}/schedules`, { agentId: PEOPLE.devA.id, name: "Daily triage", prompt: "Review the backlog", intervalMinutes: 15 }, 201);
    const { workflow } = agileShared(ctx);
    const later = new Date(Date.now() + 16 * 60_000);
    expect((await workflow.tick(later)).scheduled).toBe(1);
    expect((await workflow.tick(later)).scheduled).toBe(0);
    const { docs } = await ok("devA", "GET", "/work/mine");
    expect(docs.filter((w: any) => w.trigger === "schedule" && w.prompt === "Review the backlog")).toHaveLength(1);
    expect((await req("member", "POST", `/${P}/schedules`, { agentId: PEOPLE.member.id, name: "x", prompt: "y", intervalMinutes: 15 })).status).toBe(422);
  });
});

describe("planning", () => {
  test("labels: people define them, an agent sets them on its own issue, the list filters by them", async () => {
    const bug = await ok("staff", "POST", `/${P}/labels`, { name: "bug", color: "#ff0000" }, 201);
    const mine = await issue("devA", { name: "Labelled", assigneeId: PEOPLE.devA.id });
    await ok("devA", "PUT", `/issues/${mine.key}/labels`, { labelIds: [bug.id] });
    const { docs } = await ok("member", "GET", `/${P}/issues?labelId=${bug.id}`);
    expect(docs.map((d: any) => d.key)).toEqual([mine.key]);
  });

  test("states: entry validations, order and deleting with moveTo", async () => {
    const review = await ok("staff", "POST", `/${P}/states`, { name: "Review", group: "started", validations: { requireAssignee: true } }, 201);
    const x = await issue("member", { name: "Unassigned" });
    expect((await req("member", "PATCH", `/issues/${x.key}`, { stateId: review.id })).status).toBe(422);
    const ids = (await ok("staff", "GET", `/${P}/states`)).docs.map((s: any) => s.id).reverse();
    const reordered = await ok("staff", "PUT", `/${P}/states/order`, { stateIds: ids });
    expect(reordered.docs.map((s: any) => s.id)).toEqual(ids);
    await ok("member", "PATCH", `/issues/${x.key}`, { stateId: review.id, assigneeId: PEOPLE.member.id });
    expect((await req("staff", "DELETE", `/states/${review.id}`)).status).toBe(409);
    await ok("staff", "DELETE", `/states/${review.id}?moveTo=${states["Todo"]}`);
    expect((await ok("member", "GET", `/issues/${x.key}`)).stateId).toBe(states["Todo"]);
  });

  test("auto-assign: entering a state assigns the issue to the configured member", async () => {
    await ok("staff", "PATCH", `/projects/${P}`, { config: { autoAssign: { [states["Done"]]: PEOPLE.member.id } } });
    const x = await issue("staff", { name: "Goes to done" });
    const done = await ok("staff", "PATCH", `/issues/${x.key}`, { stateId: states["Done"] });
    expect(done.assigneeId).toBe(PEOPLE.member.id);
    expect(done.completedAt).toBeTruthy();
    await ok("staff", "PATCH", `/projects/${P}`, { config: { autoAssign: {} } });
  });

  test("closing a cycle carries its unfinished issues to the next one", async () => {
    const c1 = await ok("staff", "POST", `/${P}/cycles`, { name: "S1", startDate: "2026-10-01", endDate: "2026-10-14" }, 201);
    const c2 = await ok("staff", "POST", `/${P}/cycles`, { name: "S2", startDate: "2026-10-15", endDate: "2026-10-28" }, 201);
    const open = await issue("member", { name: "Open", cycleId: c1.id, estimate: 3 });
    const finished = await issue("member", { name: "Finished", cycleId: c1.id, estimate: 5 });
    await ok("member", "PATCH", `/issues/${finished.key}`, { stateId: states["Done"] });
    const r = await ok("staff", "POST", `/cycles/${c1.id}/complete`);
    expect(r).toMatchObject({ carriedOver: 1, carriedOverTo: c2.id });
    expect(r.cycle.stats).toMatchObject({ totalIssues: 2, completedIssues: 1, completedEstimate: 5 });
    expect((await ok("member", "GET", `/issues/${open.key}`)).cycleId).toBe(c2.id);
    expect((await ok("member", "GET", `/issues/${finished.key}`)).cycleId).toBe(c1.id);
    expect((await req("staff", "POST", `/cycles/${c1.id}/complete`)).status).toBe(409);
  });

  test("auto-archive: closed issues leave the board after the configured days", async () => {
    await ok("staff", "PATCH", `/projects/${P}`, { config: { autoArchiveDays: 1 } });
    const x = await issue("member", { name: "Old and done" });
    await ok("member", "PATCH", `/issues/${x.key}`, { stateId: states["Done"] });
    const { workflow } = agileShared(ctx);
    const r = await workflow.tick(new Date(Date.now() + 2 * 86_400_000));
    expect(r.archived).toBeGreaterThanOrEqual(1);
    const visible = await ok("member", "GET", `/${P}/issues?search=Old and done`);
    expect(visible.docs).toEqual([]);
    const all = await ok("member", "GET", `/${P}/issues?search=Old and done&includeArchived=true`);
    expect(all.docs).toHaveLength(1);
    await ok("member", "POST", `/issues/${x.key}/unarchive`);
    await ok("staff", "PATCH", `/projects/${P}`, { config: { autoArchiveDays: null } });
  });

  test("custom fields: wrong values and unknown keys are a 422, good ones are kept", async () => {
    await ok("staff", "POST", `/${P}/fields`, { key: "severity", name: "Severity", type: "select", options: ["low", "high"] }, 201);
    expect((await req("member", "POST", `/${P}/issues`, { name: "x", customFields: { severity: "mid" } })).status).toBe(422);
    expect((await req("member", "POST", `/${P}/issues`, { name: "x", customFields: { nope: 1 } })).status).toBe(422);
    const x = await issue("member", { name: "Severe", customFields: { severity: "high" } });
    expect(x.props.customFields).toEqual({ severity: "high" });
    const cleared = await ok("member", "PATCH", `/issues/${x.key}`, { customFields: { severity: null } });
    expect(cleared.props.customFields).toEqual({});
  });

  test("checklist, links and sub-issues", async () => {
    const parent = await issue("devA", { name: "Parent", assigneeId: PEOPLE.devA.id });
    const item = await ok("devA", "POST", `/issues/${parent.key}/checklist`, { text: "Write tests" }, 201);
    const ticked = await ok("devA", "PATCH", `/issues/${parent.key}/checklist/${item.id}`, { isDone: true });
    expect(ticked.doneBy).toBe(PEOPLE.devA.id);
    expect((await ok("member", "GET", `/issues/${parent.key}/checklist`)).done).toBe(1);

    const child = await issue("member", { name: "Child", parentId: parent.id });
    expect((await ok("member", "GET", `/issues/${parent.key}`)).subIssuesCount).toBe(1);
    expect((await ok("member", "GET", `/issues/${parent.key}/sub-issues`)).docs.map((d: any) => d.key)).toEqual([child.key]);

    await ok("devA", "POST", `/issues/${parent.key}/links`, { targetKey: child.key, linkType: "blocks" }, 201);
    const seen = await ok("member", "GET", `/issues/${child.key}/links`);
    expect(seen.docs[0]).toMatchObject({ linkType: "blocked_by", direction: "incoming" });
    expect((await req("devA", "POST", `/issues/${parent.key}/links`, { targetKey: parent.key, linkType: "relates_to" })).status).toBe(422);
  });

  test("saved views: a shared view groups, a private one is invisible to others", async () => {
    const shared = await ok("member", "POST", `/${P}/views`, { name: "Urgent by person", isShared: true, filters: { priorities: ["urgent", "high"] }, groupBy: "assignee" }, 201);
    const run = await ok("viewer", "GET", `/views/${shared.id}/issues`);
    expect(run.groups.length).toBeGreaterThan(0);
    const priv = await ok("member", "POST", `/${P}/views`, { name: "Mine" }, 201);
    expect((await req("viewer", "GET", `/views/${priv.id}/issues`)).status).toBe(404);
    expect((await req("viewer", "PATCH", `/views/${shared.id}`, { name: "x" })).status).toBe(403);
  });

  test("initiatives report their pace", async () => {
    const ini = await ok("staff", "POST", `/${P}/initiatives`, { name: "Launch", startDate: "2026-01-01", targetDate: "2030-12-31" }, 201);
    const a = await issue("member", { name: "Part 1", initiativeId: ini.id });
    await issue("member", { name: "Part 2", initiativeId: ini.id });
    await ok("member", "PATCH", `/issues/${a.key}`, { stateId: states["Done"] });
    const got = await ok("member", "GET", `/initiatives/${ini.id}`);
    expect(got.issues).toEqual({ total: 2, completed: 1 });
    expect(got.pace.status).toBe("on_track");
  });

  test("calendar, timeline and dashboard answer for members only", async () => {
    await issue("member", { name: "Due", targetDate: "2026-11-20" });
    const cal = await ok("viewer", "GET", `/${P}/calendar?from=2026-11-01&to=2026-11-30`);
    expect(cal.days["2026-11-20"].map((i: any) => i.name)).toContain("Due");
    expect((await req("viewer", "GET", `/${P}/calendar?from=2026-11-01`)).status).toBe(400);
    const tl = await ok("viewer", "GET", `/${P}/timeline?from=2026-10-01&to=2026-12-31`);
    expect(tl.cycles.length).toBeGreaterThan(0);
    const dash = await ok("viewer", "GET", `/${P}/dashboard?weeks=4`);
    expect(dash.throughput).toHaveLength(4);
    expect(dash.pulse.open).toBeGreaterThan(0);
    expect((await req("outsider", "GET", `/${P}/dashboard`)).status).toBe(404);
  });
});
