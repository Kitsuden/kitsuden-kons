/**
 * kon-agile 1.4 — attachments, subscribers, reactions, bulk changes, search, time, GitHub, events
 * ============================================================================
 *
 * REAL routes against PGlite with forced RLS and a non-superuser role (safe-kons-bench), like
 * kon-agile-teammates. The agent rule of 1.3 still holds for everything new: an agent attaches,
 * logs time and changes in bulk only issues in its reach, and never connects a repository.
 *
 * Layout: P (identifier PLAT) is created by `staff` (owner); `member` is member, `viewer` is viewer,
 * `outsider` is in nothing; `devA` is an agent member.
 */

import { createHmac } from "node:crypto";

import type { PGlite } from "@electric-sql/pglite";
import type { MiddlewareHandler } from "hono";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { keysIn, signatureMatches } from "../../kons/kon-agile/agile.github";
import { RULE_TEMPLATES } from "../../kons/kon-agile/agile.events";
import { createKonAgile } from "../../kons/kon-agile/index";

import { APP_ROLE, dropToAppRole, migratedBase } from "./helpers/safe-kons-bench";

const PEOPLE = {
  staff: { id: "Ss9zX7cV5bN3mQ1wE2rT4yU6iO8pA0lK", role: "editor" },
  member: { id: "Mm3N5bV7cX9zA1sD2fG4hJ6kL8qW0eRt", role: "user" },
  viewer: { id: "Bw2E4rT6yU8iO0pA1sD3fG5hJ7kL9zXc", role: "user" },
  outsider: { id: "Aq7kL2mP9zX4nT8vB1cD3eF5gH6jK0wQ", role: "user" },
  devA: { id: "agent-dev-a-0000-0000-000000000001", role: "agent", scopes: ["agile:work"] },
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

/** Seals by encoding: enough to check the kon never stores or returns the value as it came. */
const opened: string[] = [];
const secrets = {
  seal: (kon: string, value: string) => ({ v: 1, kon, valueEncrypted: Buffer.from(value).toString("base64"), iv: "iv", authTag: "tag" }),
  open: async (kon: string, sealed: { kon: string; valueEncrypted: string }, access: { purpose: string }) => {
    if (sealed.kon !== kon) throw new Error("sealed for another kon");
    opened.push(access.purpose);
    return Buffer.from(sealed.valueEncrypted, "base64").toString("utf8");
  },
};

const emitted: { name: string; data: any }[] = [];
const events = { emit: (name: string, data: unknown) => emitted.push({ name, data }), on: () => {}, off: () => {} };

let client: PGlite;
let app: { request: (u: string, i?: RequestInit) => Response | Promise<Response> };
let P: string;
let states: Record<string, string>;
const MEDIA = { pdf: "11111111-1111-4111-8111-111111111111", png: "22222222-2222-4222-8222-222222222222" };

const json = async (r: Response): Promise<any> => r.json();
async function req(who: Who | null, method: string, route: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (who) h[HEADER] = who;
  if (body !== undefined && !h["content-type"]) h["content-type"] = "application/json";
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return app.request(route, { method, headers: h, body: payload });
}
async function ok(who: Who, method: string, route: string, body?: unknown, status = 200) {
  const r = await req(who, method, route, body);
  if (r.status !== status) throw new Error(`${method} ${route} as ${who}: ${r.status} ${await r.text()}`);
  return json(r);
}
const issue = async (who: Who, body: Record<string, unknown>) => ok(who, "POST", `/${P}/issues`, body, 201);
const stateOf = async (key: string) => (await ok("staff", "GET", `/issues/${key}`)).stateId;

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
    "0006_attachments_time_github_search.sql",
  ]);
  // The core's media library, as much of it as the kon reads.
  await client.exec(`
    CREATE TABLE media (id uuid PRIMARY KEY, filename text NOT NULL, original_name text NOT NULL, mime_type text NOT NULL, size integer NOT NULL);
    INSERT INTO media VALUES ('${MEDIA.pdf}', 'a.pdf', 'spec.pdf', 'application/pdf', 1200),
                             ('${MEDIA.png}', 'b.png', 'screen.png', 'image/png', 3400);
    GRANT SELECT ON media TO ${APP_ROLE};
  `);
  const db = await dropToAppRole(client);
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as any, auth: auth as any, events: events as any });
  (ctx as any).secrets = secrets;
  app = host.mount(createKonAgile(ctx));

  P = (await ok("staff", "POST", "/projects", { name: "Plataforma", identifier: "PLAT" }, 201)).id;
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.member.id, role: "member" }, 201);
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.viewer.id, role: "viewer" }, 201);
  await ok("staff", "POST", `/projects/${P}/members`, { userId: PEOPLE.devA.id, role: "member", isAgent: true }, 201);
  const { docs } = await ok("staff", "GET", `/${P}/states`);
  states = Object.fromEntries(docs.map((s: any) => [s.name, s.id]));
});

afterAll(async () => {
  await client?.close();
});

describe("events for automation rules", () => {
  test("creating, moving, assigning and commenting emit agile events with the issue's payload", async () => {
    emitted.length = 0;
    const x = await issue("staff", { name: "Payments fail", priority: "urgent" });
    await ok("staff", "PATCH", `/issues/${x.key}`, { stateId: states["In Progress"], assigneeId: PEOPLE.member.id });
    await ok("member", "POST", `/issues/${x.key}/comments`, { contentHtml: "<p>Looking</p>" }, 201);
    const names = emitted.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining(["agile:issue.created", "agile:issue.updated", "agile:issue.state_changed", "agile:issue.assigned", "agile:issue.commented"])
    );
    const created = emitted.find((e) => e.name === "agile:issue.created")!.data;
    expect(created).toMatchObject({ projectId: P, key: x.key, priority: "urgent", stateGroup: "backlog", actorId: PEOPLE.staff.id });
    const moved = emitted.find((e) => e.name === "agile:issue.state_changed")!.data;
    expect(moved).toMatchObject({ stateGroup: "started", previousStateId: states["Backlog"] });
    expect(emitted.find((e) => e.name === "agile:issue.commented")!.data.excerpt).toBe("Looking");
  });

  test("the rule templates name only declared events and the agile mail template", async () => {
    const { events: declared, templates } = await ok("viewer", "GET", "/rule-templates");
    expect(templates.length).toBe(RULE_TEMPLATES.length);
    for (const t of templates) {
      expect(Object.keys(declared)).toContain(t.rule.triggerConfig.eventName);
      for (const step of t.rule.config.steps) {
        expect(["core:send-mail", "core:webhook"]).toContain(step.handler);
        if (step.handler === "core:send-mail") expect(step.config.mailable).toBe("agile.issue-event");
      }
    }
  });
});

describe("subscribers", () => {
  test("the creator and the assignee follow an issue; a comment notifies them, not its author", async () => {
    const x = await issue("staff", { name: "Follow me", assigneeId: PEOPLE.member.id });
    const subs = await ok("viewer", "GET", `/issues/${x.key}/subscribers`);
    expect(subs.docs.map((d: any) => d.userId).sort()).toEqual([PEOPLE.member.id, PEOPLE.staff.id].sort());
    expect(subs.subscribed).toBe(false);

    await ok("member", "POST", `/issues/${x.key}/comments`, { contentHtml: "<p>On it</p>" }, 201);
    const staffInbox = await ok("staff", "GET", "/notifications");
    expect(staffInbox.docs.some((n: any) => n.kind === "comment" && n.issueKey === x.key)).toBe(true);
    const memberInbox = await ok("member", "GET", "/notifications");
    expect(memberInbox.docs.some((n: any) => n.kind === "comment" && n.issueKey === x.key)).toBe(false);
  });

  test("a viewer follows and stops following; a state change reaches followers", async () => {
    const x = await issue("staff", { name: "Watched" });
    await ok("viewer", "POST", `/issues/${x.key}/subscribe`);
    expect((await ok("viewer", "GET", `/issues/${x.key}/subscribers`)).subscribed).toBe(true);
    await ok("staff", "PATCH", `/issues/${x.key}`, { stateId: states["Todo"] });
    const inbox = await ok("viewer", "GET", "/notifications");
    expect(inbox.docs.some((n: any) => n.kind === "state_changed" && n.issueKey === x.key)).toBe(true);
    await ok("viewer", "DELETE", `/issues/${x.key}/subscribe`);
    expect((await ok("viewer", "GET", `/issues/${x.key}/subscribers`)).subscribed).toBe(false);
    expect((await req("outsider", "POST", `/issues/${x.key}/subscribe`)).status).toBe(404);
  });
});

describe("reactions", () => {
  test("any member reacts for itself and a second time removes it; an outsider gets 404", async () => {
    const x = await issue("staff", { name: "React" });
    const comment = await ok("staff", "POST", `/issues/${x.key}/comments`, { contentHtml: "<p>Ship it?</p>" }, 201);
    const a = await ok("viewer", "POST", `/comments/${comment.id}/reactions`, { emoji: "👍" });
    expect(a.reactions["👍"]).toEqual([PEOPLE.viewer.id]);
    const b = await ok("devA", "POST", `/comments/${comment.id}/reactions`, { emoji: "👍" });
    expect(b.reactions["👍"].sort()).toEqual([PEOPLE.viewer.id, PEOPLE.devA.id].sort());
    const c = await ok("viewer", "POST", `/comments/${comment.id}/reactions`, { emoji: "👍" });
    expect(c.reactions["👍"]).toEqual([PEOPLE.devA.id]);
    expect((await req("outsider", "POST", `/comments/${comment.id}/reactions`, { emoji: "👍" })).status).toBe(404);
    // A viewer still may not edit the comment itself.
    const edited = await sqlAs("viewer", `UPDATE agile_comments SET content_html = 'x' WHERE id = $1 RETURNING id`, [comment.id]);
    expect(edited).toHaveLength(0);
  });
});

describe("attachments", () => {
  test("a writer attaches a media file once; the count and the history follow", async () => {
    const x = await issue("staff", { name: "With files" });
    const a = await ok("member", "POST", `/issues/${x.key}/attachments`, { mediaId: MEDIA.pdf }, 201);
    expect(a).toMatchObject({ name: "spec.pdf", mimeType: "application/pdf", size: 1200 });
    expect((await req("member", "POST", `/issues/${x.key}/attachments`, { mediaId: MEDIA.pdf })).status).toBe(409);
    expect((await req("member", "POST", `/issues/${x.key}/attachments`, { mediaId: "33333333-3333-4333-8333-333333333333" })).status).toBe(422);
    expect((await req("viewer", "POST", `/issues/${x.key}/attachments`, { mediaId: MEDIA.png })).status).toBe(403);
    expect((await ok("viewer", "GET", `/issues/${x.key}`)).attachmentsCount).toBe(1);
    expect((await ok("viewer", "GET", `/issues/${x.key}/attachments`)).totalDocs).toBe(1);
    await ok("member", "DELETE", `/issues/${x.key}/attachments/${a.id}`);
    expect((await ok("viewer", "GET", `/issues/${x.key}`)).attachmentsCount).toBe(0);
  });

  test("an agent attaches only to issues in its reach, and the database refuses the rest", async () => {
    const mine = await issue("staff", { name: "Agent's", assigneeId: PEOPLE.devA.id });
    const theirs = await issue("staff", { name: "Member's", assigneeId: PEOPLE.member.id });
    await ok("devA", "POST", `/issues/${mine.key}/attachments`, { mediaId: MEDIA.png }, 201);
    expect((await req("devA", "POST", `/issues/${theirs.key}/attachments`, { mediaId: MEDIA.png })).status).toBe(403);
    await expect(
      sqlAs("devA", `INSERT INTO agile_issue_attachments (issue_id, media_id, name, created_by) VALUES ($1, $2, 'x', $3)`, [theirs.id, MEDIA.png, PEOPLE.devA.id])
    ).rejects.toThrow(/row-level security/);
  });
});

describe("bulk changes", () => {
  test("moves many issues at once, with history and events for each", async () => {
    const a = await issue("staff", { name: "Bulk A" });
    const b = await issue("staff", { name: "Bulk B" });
    emitted.length = 0;
    const r = await ok("member", "POST", `/${P}/issues/bulk`, { keys: [a.key, b.key], set: { stateId: states["Done"], priority: "low" } });
    expect(r.updated).toBe(2);
    expect(await stateOf(a.key)).toBe(states["Done"]);
    expect((await ok("staff", "GET", `/issues/${b.key}`)).completedAt).toBeTruthy();
    expect(emitted.filter((e) => e.name === "agile:issue.state_changed")).toHaveLength(2);
  });

  test("all or nothing: one missing or out-of-reach issue changes none", async () => {
    const mine = await issue("staff", { name: "Bulk mine", assigneeId: PEOPLE.devA.id });
    const theirs = await issue("staff", { name: "Bulk theirs", assigneeId: PEOPLE.member.id });
    const r1 = await req("devA", "POST", `/${P}/issues/bulk`, { keys: [mine.key, theirs.key], set: { stateId: states["Todo"] } });
    expect(r1.status).toBe(403);
    expect((await r1.text())).toContain(theirs.key);
    const r2 = await req("member", "POST", `/${P}/issues/bulk`, { keys: [mine.key, "PLAT-99999"], set: { stateId: states["Todo"] } });
    expect(r2.status).toBe(404);
    expect(await stateOf(mine.key)).toBe(states["Backlog"]);
    expect(await stateOf(theirs.key)).toBe(states["Backlog"]);
  });

  test("labels added and removed, and archiving, in one call", async () => {
    const label = await ok("staff", "POST", `/${P}/labels`, { name: "bulk-label" }, 201);
    const a = await issue("staff", { name: "Label me" });
    await ok("staff", "POST", `/${P}/issues/bulk`, { keys: [a.key], addLabelIds: [label.id] });
    expect((await sqlAs("staff", `SELECT 1 FROM agile_issue_labels WHERE issue_id = $1`, [a.id])).length).toBe(1);
    await ok("staff", "POST", `/${P}/issues/bulk`, { keys: [a.key], removeLabelIds: [label.id], archive: true });
    expect((await sqlAs("staff", `SELECT 1 FROM agile_issue_labels WHERE issue_id = $1`, [a.id])).length).toBe(0);
    expect((await ok("staff", "GET", `/issues/${a.key}`)).archivedAt).toBeTruthy();
    expect((await req("viewer", "POST", `/${P}/issues/bulk`, { keys: [a.key], archive: false })).status).toBe(403);
  });
});

describe("full-text search", () => {
  test("finds words in the description and in comments, and a half-typed key", async () => {
    const a = await issue("staff", { name: "Login page", descriptionHtml: "<p>The OAuth callback loses the session cookie</p>" });
    const b = await issue("staff", { name: "Unrelated title" });
    await ok("staff", "POST", `/issues/${b.key}/comments`, { contentHtml: "<p>Probably the webhook retries</p>" }, 201);

    const byDescription = await ok("viewer", "GET", `/${P}/search?q=cookie`);
    expect(byDescription.docs[0]).toMatchObject({ key: a.key, matchedIn: "description" });
    expect(byDescription.docs[0].snippet).toContain("«cookie»");

    const byComment = await ok("viewer", "GET", `/${P}/search?q=webhook`);
    expect(byComment.docs.map((d: any) => d.key)).toContain(b.key);
    expect(byComment.docs.find((d: any) => d.key === b.key).matchedIn).toBe("comment");

    const list = await ok("viewer", "GET", `/${P}/issues?search=${encodeURIComponent("session cookie")}`);
    expect(list.docs.map((d: any) => d.key)).toEqual([a.key]);
    const partial = await ok("viewer", "GET", `/${P}/search?q=${encodeURIComponent(a.key.slice(0, -1))}`);
    expect(partial.docs.map((d: any) => d.key)).toContain(a.key);
    expect((await req("outsider", "GET", `/${P}/search?q=cookie`)).status).toBe(404);
    expect((await req("viewer", "GET", `/${P}/search?q=x`)).status).toBe(422);
  });
});

describe("time and cost", () => {
  test("people log their time; the cost adds the hourly rate and what agents reported", async () => {
    await ok("staff", "PATCH", `/projects/${P}`, { config: { hourlyRateUsd: 60 } });
    const x = await issue("staff", { name: "Costly", assigneeId: PEOPLE.devA.id });
    await ok("member", "POST", `/issues/${x.key}/time`, { minutes: 90, spentOn: "2026-11-10", note: "review" }, 201);
    await ok("devA", "POST", `/issues/${x.key}/time`, { minutes: 30 }, 201);
    const [work] = (await ok("devA", "GET", "/work/mine")).docs.filter((w: any) => w.issueId === x.id);
    await ok("devA", "POST", `/work/${work.id}/claim`, {});
    await ok("devA", "POST", `/work/${work.id}/finish`, { status: "done", inputTokens: 1000, outputTokens: 200, costUsd: 0.25 });

    const cost = await ok("viewer", "GET", `/issues/${x.key}/cost`);
    expect(cost.people).toMatchObject({ minutes: 120, hours: 2, costUsd: 120 });
    expect(cost.agents).toMatchObject({ runs: 1, inputTokens: 1000, outputTokens: 200, costUsd: 0.25 });
    expect(cost.totalCostUsd).toBe(120.25);
    expect((await ok("viewer", "GET", `/issues/${x.key}/time`)).totalMinutes).toBe(120);
    const report = await ok("viewer", "GET", `/${P}/time?from=2026-11-01`);
    expect(report.byUser.find((u: any) => u.userId === PEOPLE.member.id).minutes).toBe(90);
  });

  test("time is always the caller's own, on issues in its reach", async () => {
    const theirs = await issue("staff", { name: "Not the agent's", assigneeId: PEOPLE.member.id });
    expect((await req("devA", "POST", `/issues/${theirs.key}/time`, { minutes: 10 })).status).toBe(403);
    expect((await req("viewer", "POST", `/issues/${theirs.key}/time`, { minutes: 10 })).status).toBe(403);
    await expect(
      sqlAs("member", `INSERT INTO agile_time_entries (project_id, issue_id, user_id, minutes, spent_on) VALUES ($1, $2, $3, 10, '2026-11-11')`, [P, theirs.id, PEOPLE.staff.id])
    ).rejects.toThrow(/row-level security/);
    const entry = await ok("member", "POST", `/issues/${theirs.key}/time`, { minutes: 15 }, 201);
    expect((await req("devA", "DELETE", `/time/${entry.id}`)).status).toBe(403);
    await ok("member", "PATCH", `/time/${entry.id}`, { minutes: 20 });
    await ok("staff", "DELETE", `/time/${entry.id}`);
  });
});

describe("GitHub pull requests", () => {
  const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  test("keys and closing words are read from title, body and branch", () => {
    const { mentioned, closes } = keysIn("PLAT", ["Fixes plat-3 and touches PLAT-4", "closes: PLAT-5", "feature/plat-6-login", "PLAT-70x"]);
    expect(mentioned.sort()).toEqual(["PLAT-3", "PLAT-4", "PLAT-5", "PLAT-6"].sort());
    expect([...closes].sort()).toEqual(["PLAT-3", "PLAT-5"]);
    expect(signatureMatches("s", new TextEncoder().encode("{}").buffer as ArrayBuffer, sign("s", "{}"))).toBe(true);
    expect(signatureMatches("s", new TextEncoder().encode("{}").buffer as ArrayBuffer, "sha256=00")).toBe(false);
  });

  test("a person connects a repository; the secret is shown once and stored sealed", async () => {
    expect((await req("devA", "POST", `/${P}/github`, { repo: "acme/web" })).status).toBe(403);
    expect((await req("viewer", "POST", `/${P}/github`, { repo: "acme/web" })).status).toBe(403);
    const repo = await ok("staff", "POST", `/${P}/github`, { repo: "Acme/Web" }, 201);
    expect(repo.repo).toBe("acme/web");
    expect(repo.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(repo.webhookUrl).toBe(`http://localhost:3000/api/agile/github/webhook/${repo.id}`);
    expect((await req("staff", "POST", `/${P}/github`, { repo: "acme/web" })).status).toBe(409);
    const listed = await ok("viewer", "GET", `/${P}/github`);
    expect(JSON.stringify(listed)).not.toContain(repo.webhookSecret);
    const [row] = await sqlAs<{ webhook_secret: any }>("staff", `SELECT webhook_secret FROM agile_github_repos WHERE id = $1`, [repo.id]);
    expect(JSON.stringify(row.webhook_secret)).not.toContain(repo.webhookSecret);
  });

  test("a signed merged pull request that fixes an issue links it and completes it", async () => {
    const repo = await ok("staff", "POST", `/${P}/github`, { repo: "acme/api" }, 201);
    const target = await issue("staff", { name: "Fix the login" });
    const other = await issue("staff", { name: "Only mentioned" });
    const url = `/github/webhook/${repo.id}`;
    const payload = (merged: boolean) =>
      JSON.stringify({
        action: "closed",
        repository: { full_name: "acme/api" },
        pull_request: {
          number: 42,
          title: `Fix login (fixes ${target.key})`,
          body: `Also touches ${other.key}.`,
          html_url: "https://github.com/acme/api/pull/42",
          state: merged ? "closed" : "open",
          merged,
          user: { login: "octo" },
          head: { ref: "fix/login" },
        },
      });

    const bad = await req(null, "POST", url, payload(true), { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=deadbeef", "content-type": "application/json" });
    expect(bad.status).toBe(401);
    expect(await stateOf(target.key)).toBe(states["Backlog"]);

    const ping = await req(null, "POST", url, "{}", { "x-github-event": "ping", "x-hub-signature-256": sign(repo.webhookSecret, "{}"), "content-type": "application/json" });
    expect(ping.status).toBe(200);

    const open = payload(false);
    const r1 = await req(null, "POST", url, open, { "x-github-event": "pull_request", "x-hub-signature-256": sign(repo.webhookSecret, open), "content-type": "application/json" });
    expect(r1.status).toBe(200);
    expect((await json(r1)).linked.sort()).toEqual([target.key, other.key].sort());
    expect(await stateOf(target.key)).toBe(states["Backlog"]);

    emitted.length = 0;
    const merged = payload(true);
    const r2 = await req(null, "POST", url, merged, { "x-github-event": "pull_request", "x-hub-signature-256": sign(repo.webhookSecret, merged), "content-type": "application/json" });
    expect((await json(r2)).completed).toEqual([target.key]);
    expect(await stateOf(target.key)).toBe(states["Done"]);
    expect(await stateOf(other.key)).toBe(states["Backlog"]);
    expect(emitted.some((e) => e.name === "agile:pull_request.linked" && e.data.state === "merged")).toBe(true);

    const prs = await ok("viewer", "GET", `/issues/${target.key}/pull-requests`);
    expect(prs.docs).toEqual([expect.objectContaining({ repo: "acme/api", number: 42, state: "merged", closesIssue: true, author: "octo" })]);
    expect(opened).toContain("verify-github-webhook");
  });

  test("a delivery for another repository is refused, even with the right signature", async () => {
    const repo = await ok("staff", "POST", `/${P}/github`, { repo: "acme/docs" }, 201);
    const body = JSON.stringify({ repository: { full_name: "evil/repo" }, pull_request: { number: 1, title: "fixes PLAT-1", html_url: "https://x", state: "open" } });
    const r = await req(null, "POST", `/github/webhook/${repo.id}`, body, { "x-github-event": "pull_request", "x-hub-signature-256": sign(repo.webhookSecret, body), "content-type": "application/json" });
    expect(r.status).toBe(422);
    expect((await req(null, "POST", `/github/webhook/00000000-0000-4000-8000-000000000000`, body, { "x-github-event": "pull_request" })).status).toBe(404);
  });
});
