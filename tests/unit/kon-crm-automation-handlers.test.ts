/**
 * kon-crm's steps for Kitsuden's automation rules, and its stage actions becoming rules
 * ============================================================================
 *
 * kon-crm's migrations on PGlite as the NON-superuser app role with no user in the context: what a rule's
 * step runs as (the host runs it after the commit, on the system connection). The host's `ctx.automation` is
 * a double that records the rules it is given, with the contract's shape.
 *
 * What these tests hold:
 *   - each step does what the stage action of the same name did, on the event's deal by default;
 *   - a stage action's condition is checked on the deal the step loads, not on the event;
 *   - `move-stage` goes through the same entry requirements as a person;
 *   - a bad config is refused when the rule is saved (`validate`);
 *   - with the engine, a stage's actions become two rules and the stage's columns empty, and only after
 *     both are stored; without it, nothing moves and the CRM's runner keeps them.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { useCrmEvents } from "../../kons/kon-crm/crm.events";
import {
  CRM_ACTION_HANDLERS,
  rulesOfStage,
  stageActionToStep,
  syncStageRules,
  type HandlerInput,
  type KonRule,
} from "../../kons/kon-crm/crm.handlers";

import { APP_ROLE, dropToAppRole, migratedBase } from "./helpers/safe-kons-bench";

let client: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;
const emitted: Array<{ name: string; data: Record<string, unknown> }> = [];

const handler = (id: string) => {
  const h = CRM_ACTION_HANDLERS.find((x) => x.id === id);
  if (!h) throw new Error(`no handler ${id}`);
  return h;
};
const input = (config: Record<string, unknown>, event?: Record<string, unknown>): HandlerInput => ({
  config,
  event: event ? { name: "crm:deal.moved", data: event } : undefined,
  rule: { id: "rule-1", name: "Test rule" },
  actorUserId: "u-owner",
});
const ctxWith = (automation?: unknown) => ({ db: { instance: db }, ...(automation ? { automation } : {}) }) as never;

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('p1', 'Sales');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order", entry_requirements) VALUES
      ('s1', 'p1', 'Lead', 0, '{}'),
      ('s2', 'p1', 'Proposal', 1, '{}'),
      ('s3', 'p1', 'Contract', 2, '{"requiredFields": ["signedBy"]}');
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES ('c1', 'Ana', 'Ortega', 'ana@client.example');
    INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id, value, assigned_to)
      VALUES ('d1', 'Big deal', 'p1', 's1', 'c1', 5000, 'u-seller'), ('d2', 'Small deal', 'p1', 's1', 'c1', 100, 'u-seller');
  `);
  db = await dropToAppRole(client);
  useCrmEvents({ emit: (name: string, data: Record<string, unknown>) => emitted.push({ name, data }), on: () => undefined } as never);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  emitted.length = 0;
});

describe("the steps", () => {
  it("declares the six steps, each with a label and a description", () => {
    expect(CRM_ACTION_HANDLERS.map((h) => h.id).sort()).toEqual([
      "create-activity",
      "create-calendar-event",
      "create-task",
      "log-time",
      "move-stage",
      "update-field",
    ]);
    for (const h of CRM_ACTION_HANDLERS) {
      expect(h.label.length).toBeGreaterThan(3);
      expect(h.description.length).toBeGreaterThan(10);
    }
  });

  it("create-activity writes on the event's deal, as the rule's owner, marked as automation", async () => {
    const out = (await handler("create-activity").run(input({ subject: "Send the proposal", type: "email" }, { dealId: "d1" }), ctxWith())) as {
      activityId: string;
    };
    const [row] = await q<{ type: string; contact_id: string; created_by: string; origin: string; metadata: Record<string, unknown> }>(
      `SELECT type, contact_id, created_by, origin, metadata FROM crm_activities WHERE id = '${out.activityId}'`
    );
    expect(row).toMatchObject({ type: "email", contact_id: "c1", created_by: "u-owner", origin: "automation", metadata: { ruleId: "rule-1" } });
  });

  it("create-activity also works on a contact alone", async () => {
    const out = (await handler("create-activity").run(input({ subject: "Welcome call", type: "call", contactId: "c1" }), ctxWith())) as {
      activityId: string;
    };
    const [row] = await q<{ deal_id: string | null }>(`SELECT deal_id FROM crm_activities WHERE id = '${out.activityId}'`);
    expect(row!.deal_id).toBeNull();
  });

  it("a stage action's condition is checked on the deal the step loads", async () => {
    const step = handler("create-task");
    const condition = { field: "value", operator: ">", value: 1000 };
    expect(await step.run(input({ title: "Legal review", value: 2, condition }, { dealId: "d2" }), ctxWith())).toEqual({
      skipped: "condition not met",
      dealId: "d2",
    });
    expect(await step.run(input({ title: "Legal review", value: 2, condition }, { dealId: "d1" }), ctxWith())).toEqual({
      done: "create_task",
      dealId: "d1",
    });
    const tasks = await q<{ assigned_to: string; due_date: Date }>(`SELECT assigned_to, due_date FROM crm_activities WHERE subject = 'Legal review'`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.assigned_to).toBe("u-seller");
    expect(tasks[0]!.due_date).not.toBeNull();
  });

  it("update-field closing a deal announces it as crm:deal.won", async () => {
    await handler("update-field").run(input({ field: "status", value: "won" }, { dealId: "d2" }), ctxWith());
    const [row] = await q<{ status: string }>(`SELECT status FROM crm_deals WHERE id = 'd2'`);
    expect(row!.status).toBe("won");
    expect(emitted.map((e) => e.name)).toEqual(["crm:deal:status-changed", "crm:deal.won"]);
  });

  it("update-field refuses what a stage may not change", async () => {
    await expect(handler("update-field").run(input({ field: "value", value: 1 }, { dealId: "d1" }), ctxWith())).rejects.toThrow(
      /cannot change value/
    );
  });

  it("move-stage moves the deal like a person would, and records who and why", async () => {
    const out = await handler("move-stage").run(input({ stageId: "s2" }, { dealId: "d1" }), ctxWith());
    expect(out).toEqual({ dealId: "d1", moved: true, stageId: "s2" });
    const [t] = await q<{ moved_by: string; move_reason: string }>(`SELECT moved_by, move_reason FROM crm_stage_transitions WHERE deal_id = 'd1' AND to_stage_id = 's2'`);
    expect(t).toEqual({ moved_by: "u-owner", move_reason: "Rule: Test rule" });
    expect(emitted.map((e) => e.name)).toEqual(["crm:deal:stage-changed", "crm:deal.moved"]);
    // Again: already there, nothing written.
    expect(await handler("move-stage").run(input({ stageId: "s2", dealId: "d1" }), ctxWith())).toEqual({ dealId: "d1", moved: false, stageId: "s2" });
  });

  it("move-stage meets the stage's entry requirements: a rule cannot skip them", async () => {
    await expect(handler("move-stage").run(input({ stageId: "s3" }, { dealId: "d1" }), ctxWith())).rejects.toMatchObject({ status: 400 });
    const [row] = await q<{ stage_id: string }>(`SELECT stage_id FROM crm_deals WHERE id = 'd1'`);
    expect(row!.stage_id).toBe("s2");
  });

  it("a step with no deal anywhere fails, it does not guess", async () => {
    await expect(handler("create-task").run(input({ title: "x" }), ctxWith())).rejects.toThrow(/needs a dealId/);
  });

  it("validate refuses a bad config when the rule is saved", () => {
    expect(handler("create-activity").validate!({ type: "fax", subject: "x" })).toMatch(/type must be/);
    expect(handler("create-activity").validate!({ type: "call" })).toMatch(/subject is required/);
    expect(handler("log-time").validate!({ value: 0 })).toMatch(/hours above 0/);
    expect(handler("move-stage").validate!({})).toMatch(/stageId is required/);
    expect(handler("create-task").validate!({ condition: { field: "value", operator: "~=" } })).toMatch(/condition must be/);
    expect(handler("create-task").validate!({ title: "ok", value: 1 })).toBeNull();
  });
});

describe("stage actions become rules", () => {
  it("each supported action becomes a step; webhook and send_email are dropped", () => {
    expect(stageActionToStep({ type: "create_task", title: "Call", value: 3 })).toEqual({
      handler: "kon-crm:create-task",
      config: { title: "Call", value: 3 },
      continueOnError: true,
    });
    expect(stageActionToStep({ type: "webhook", url: "https://x.example" })).toBeNull();
    expect(stageActionToStep({ type: "send_email", template: "t" })).toBeNull();
  });

  it("a stage gives an enter rule on toStageId and an exit rule on fromStageId", () => {
    const { enter, exit } = rulesOfStage({
      id: "s2",
      name: "Proposal",
      onEnterActions: [{ type: "create_task", title: "Follow up", value: 2 }],
      onExitActions: [{ type: "log_time", value: 1 }],
    });
    expect(enter).toMatchObject({ slug: "stage-s2-enter", event: "crm:deal.moved", conditions: [{ field: "toStageId", op: "eq", value: "s2" }] });
    expect(exit).toMatchObject({ slug: "stage-s2-exit", conditions: [{ field: "fromStageId", op: "eq", value: "s2" }] });
    expect(rulesOfStage({ id: "s9", name: "Empty", onEnterActions: [], onExitActions: null })).toEqual({ enter: null, exit: null });
  });

  it("without the engine nothing moves: the CRM's runner keeps the actions", async () => {
    await client.exec(`RESET ROLE; UPDATE crm_pipeline_stages SET on_enter_actions = '[{"type":"create_task","title":"Prepare"}]' WHERE id = 's2'; SET ROLE ${APP_ROLE};`);
    expect(await syncStageRules(ctxWith(), db)).toEqual({ engine: false, rules: [], stages: [] });
    const [row] = await q<{ on_enter_actions: unknown[] }>(`SELECT on_enter_actions FROM crm_pipeline_stages WHERE id = 's2'`);
    expect(row!.on_enter_actions).toHaveLength(1);
  });

  it("a failed store leaves the stage's actions where they were", async () => {
    const failing = { upsertRule: async () => Promise.reject(new Error("engine down")), removeRule: async () => false, listRules: async () => [] };
    await expect(syncStageRules(ctxWith(failing), db)).rejects.toThrow("engine down");
    const [row] = await q<{ on_enter_actions: unknown[] }>(`SELECT on_enter_actions FROM crm_pipeline_stages WHERE id = 's2'`);
    expect(row!.on_enter_actions).toHaveLength(1);
  });

  it("with the engine, the actions become the kon's rules and the stage's columns empty", async () => {
    const stored: Array<{ kon: string; rule: KonRule }> = [];
    const automation = {
      upsertRule: async (kon: string, rule: KonRule) => stored.push({ kon, rule }),
      removeRule: async () => true,
      listRules: async () => [],
    };
    const result = await syncStageRules(ctxWith(automation), db);
    expect(result).toEqual({ engine: true, rules: ["stage-s2-enter"], stages: ["s2"] });
    expect(stored).toEqual([{ kon: "kon-crm", rule: expect.objectContaining({ slug: "stage-s2-enter" }) }]);
    const [row] = await q<{ on_enter_actions: unknown[]; on_exit_actions: unknown[] }>(
      `SELECT on_enter_actions, on_exit_actions FROM crm_pipeline_stages WHERE id = 's2'`
    );
    expect(row).toEqual({ on_enter_actions: [], on_exit_actions: [] });
    // A second start finds nothing left to move.
    expect((await syncStageRules(ctxWith(automation), db)).stages).toEqual([]);
  });
});
