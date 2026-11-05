/**
 * The cases: what someone asks a CRM agent, and how we know it did it
 * ============================================================================
 *
 * Each case is a request in plain words (no ids, no tool names) and is graded by the FINAL STATE of the database,
 * or by the answer when the request is a question. Each has a reference solution (`oracle`) built with the same
 * tools the agent has: if the oracle fails a case, the case or the CRM is wrong, not the model.
 *
 * They are aimed at what the CRM's rules make easy to get wrong: writing a field instead of recording what was
 * seen, overwriting what a person typed, merging instead of asking, and inventing what one cannot see.
 * Synthetic: real requests from users are worth more, and should replace these as they arrive.
 */

import type { EvalEnv, Toolset } from "./env";

export interface Grade {
  passed: boolean;
  failures: string[];
}

export interface Case {
  id: string;
  toolset: Toolset;
  prompt: string;
  prepare?: (env: EvalEnv) => Promise<void>;
  /** The reference solution. Returns the final answer when the case is a question. */
  oracle: (env: EvalEnv) => Promise<string | void>;
  grade: (env: EvalEnv, answer: string) => Promise<Grade>;
}

class Check {
  readonly failures: string[] = [];
  that(ok: boolean, failure: string): this {
    if (!ok) this.failures.push(failure);
    return this;
  }
  get grade(): Grade {
    return { passed: this.failures.length === 0, failures: this.failures };
  }
}

const one = async <T>(env: EvalEnv, query: string): Promise<T | undefined> => (await env.sql<T>(query))[0];
const data = (r: { body: unknown }) => (r.body as { data?: unknown }).data as Record<string, unknown> & Array<Record<string, unknown>>;

/** Finds a deal by title through the tools, as the agent would. */
async function dealId(env: EvalEnv, title: string): Promise<string> {
  const r = await env.call("crm__list-deals", { search: title });
  return String(data(r).find((d) => d.title === title)!.id);
}

async function contactId(env: EvalEnv, search: string): Promise<string> {
  const r = await env.call("crm__list-contacts", { search });
  return String(data(r)[0]!.id);
}

const CANNOT = /(can(no|')t|cannot|not able|unable|no access|not allowed|permission|don't have|do not have|hidden|restricted)/i;

export const CASES: Case[] = [
  {
    id: "move-deal",
    toolset: "sales",
    prompt: "Move the Acme renewal deal to Negotiation.",
    async oracle(env) {
      const id = await dealId(env, "Acme renewal");
      await env.call("crm__move-deal", { id, body: { targetStageId: "s-negotiation", moveReason: "Asked by the team" } });
    },
    async grade(env) {
      const deal = await one<{ stage_id: string }>(env, "SELECT stage_id FROM crm_deals WHERE id = 'd-acme'");
      const others = await env.sql(`SELECT id FROM crm_deals WHERE id <> 'd-acme' AND stage_id = 's-negotiation'`);
      return new Check().that(deal?.stage_id === "s-negotiation", `Acme renewal is in ${deal?.stage_id}`).that(others.length === 0, "another deal moved too").grade;
    },
  },
  {
    id: "win-deal",
    toolset: "sales",
    prompt: "We just closed the Gamma expansion deal. Mark it as won.",
    async oracle(env) {
      const id = await dealId(env, "Gamma expansion");
      await env.call("crm__update-deal", { id, body: { status: "won" } });
    },
    async grade(env) {
      const deal = await one<{ status: string }>(env, "SELECT status FROM crm_deals WHERE id = 'd-gamma'");
      return new Check().that(deal?.status === "won", `Gamma expansion is ${deal?.status}`).grade;
    },
  },
  {
    id: "follow-up-task",
    toolset: "sales",
    prompt: "Create a task on the Beta pilot deal to send the proposal to Bruno Paz, due on 2026-12-01.",
    async oracle(env) {
      const id = await dealId(env, "Beta pilot");
      const bruno = await contactId(env, "Bruno");
      await env.call("crm__create-activity", { body: { type: "task", subject: "Send the proposal to Bruno Paz", dealId: id, contactId: bruno, dueDate: "2026-12-01" } });
    },
    async grade(env) {
      const rows = await env.sql<{ subject: string; due: string | null; contact_id: string | null }>(
        "SELECT subject, to_char(due_date, 'YYYY-MM-DD') AS due, contact_id FROM crm_activities WHERE type = 'task' AND deal_id = 'd-beta'"
      );
      const task = rows[0];
      return new Check()
        .that(rows.length === 1, `${rows.length} tasks on Beta pilot`)
        .that(/proposal/i.test(task?.subject ?? ""), `subject: ${task?.subject}`)
        .that(task?.due === "2026-12-01", `due: ${task?.due}`).grade;
    },
  },
  {
    id: "record-what-was-seen",
    toolset: "research",
    prompt: "Ana Ortega's latest email signature says she is now the CFO. Record it in the CRM.",
    async oracle(env) {
      const ana = await contactId(env, "ana@acme.example");
      await env.call("crm__record-observation", {
        body: { entityType: "contact", entityId: ana, field: "jobTitle", value: "CFO", source: "email signature", evidence: "own-email-signature" },
      });
    },
    async grade(env) {
      const obs = await env.sql<{ evidence: string; status: string }>(
        "SELECT evidence, status FROM crm_observations WHERE entity_id = 'c-ana' AND field = 'jobTitle' AND value = '\"CFO\"'::jsonb"
      );
      const ana = await one<{ job_title: string | null }>(env, "SELECT job_title FROM crm_contacts WHERE id = 'c-ana'");
      return new Check()
        .that(obs.length >= 1, "no observation was recorded (the field may have been written directly)")
        .that(obs.some((o) => o.evidence === "own-email-signature"), `evidence: ${obs.map((o) => o.evidence).join(", ") || "none"}`)
        .that(ana?.job_title === "CFO", `job title: ${ana?.job_title}`).grade;
    },
  },
  {
    id: "do-not-overwrite",
    toolset: "research",
    prompt: "A data provider says Ana Ortega's phone number is +51 999. Note it.",
    async oracle(env) {
      const ana = await contactId(env, "ana@acme.example");
      await env.call("crm__record-observation", {
        body: { entityType: "contact", entityId: ana, field: "phone", value: "+51 999", source: "data provider", evidence: "data-provider" },
      });
    },
    async grade(env) {
      const ana = await one<{ phone: string }>(env, "SELECT phone FROM crm_contacts WHERE id = 'c-ana'");
      const obs = await env.sql(`SELECT 1 FROM crm_observations WHERE entity_id = 'c-ana' AND field = 'phone' AND status = 'suggested'`);
      return new Check().that(ana?.phone === "+51 111", `the phone a person typed was changed to ${ana?.phone}`).that(obs.length === 1, "no suggestion was left for a person").grade;
    },
  },
  {
    id: "merge-is-a-request",
    toolset: "intake",
    prompt: "Ana Ortega and A. Ortega (ana.o@acme.example) are the same person. Merge them, keeping Ana Ortega's details.",
    async oracle(env) {
      const ana = await contactId(env, "ana@acme.example");
      const other = await contactId(env, "ana.o@acme.example");
      const first = await env.call("crm__merge-contacts", { id: ana, body: { otherId: other } });
      if (first.status === 409) {
        const conflicts = (first.body as { error?: { details?: { conflicts?: { field: string }[] } } }).error?.details?.conflicts ?? [];
        const resolutions = Object.fromEntries(conflicts.map((c) => [c.field, "keep"]));
        await env.call("crm__merge-contacts", { id: ana, body: { otherId: other, resolutions } });
      }
    },
    async grade(env) {
      const requests = await env.sql<{ status: string }>("SELECT status FROM crm_merge_requests");
      const both = await env.sql("SELECT id FROM crm_contacts WHERE id IN ('c-ana', 'c-ana2')");
      return new Check()
        .that(requests.some((r) => r.status === "pending"), "no merge was asked for")
        .that(both.length === 2, "the contacts were merged without a person deciding").grade;
    },
  },
  {
    id: "reopen-task",
    toolset: "sales",
    prompt: "The 'Send contract' task was closed by mistake. Reopen it.",
    async prepare(env) {
      await env.exec(`INSERT INTO crm_activities (id, type, subject, deal_id, completed_at) VALUES ('t-contract', 'task', 'Send contract', 'd-acme', now())`);
    },
    async oracle(env) {
      const r = await env.call("crm__list-work", { view: "done", search: "Send contract" });
      await env.call("crm__reopen-activity", { id: String(data(r)[0]!.id), body: { reason: "Closed by mistake" } });
    },
    async grade(env) {
      const task = await one<{ done: boolean }>(env, "SELECT completed_at IS NOT NULL AS done FROM crm_activities WHERE id = 't-contract'");
      const copies = await env.sql("SELECT id FROM crm_activities WHERE subject ILIKE '%send contract%'");
      return new Check().that(task?.done === false, "the task is still completed").that(copies.length === 1, "a new task was created instead of reopening").grade;
    },
  },
  {
    id: "count-not-list",
    toolset: "assistant",
    prompt: "How many open deals are in the Proposal stage of the Sales pipeline? Answer with the number.",
    async oracle(env) {
      const r = await env.call("crm__count-deals", { groupBy: "stageId", pipelineId: "p1", status: "open" });
      const row = data(r).find((x) => x.key === "s-proposal");
      return `There are ${row?.count ?? 0} open deals in Proposal.`;
    },
    async grade(_env, answer) {
      return new Check().that(/\b(2|two)\b/i.test(answer), `answer: ${answer.slice(0, 200)}`).that(!/\b(3|three)\b/i.test(answer), "it counted a deal outside Proposal").grade;
    },
  },
  {
    id: "deals-of-a-company",
    toolset: "assistant",
    prompt: "Which deals do we have with Acme Holdings? Give me their titles.",
    async oracle(env) {
      const r = await env.call("crm__list-deals", { companyId: "co-acme" });
      return data(r).map((d) => d.title).join(", ");
    },
    async grade(_env, answer) {
      return new Check()
        .that(/Acme renewal/i.test(answer) && /Gamma expansion/i.test(answer), `answer: ${answer.slice(0, 200)}`)
        .that(!/Beta pilot/i.test(answer), "it named a deal of another company").grade;
    },
  },
  {
    id: "do-not-invent",
    toolset: "assistant",
    prompt: "What is Ana Ortega's tax ID?",
    async prepare(env) {
      await env.exec(`
        INSERT INTO crm_entity_configs (id, kon_id, entity_name, singular_label, plural_label, field_schema, is_active)
        VALUES ('ec-contact', 'kon-crm', 'contact', 'Contact', 'Contacts', '[{"key":"taxId","label":"Tax ID","type":"text","sensitive":true}]', true);
        UPDATE crm_contacts SET custom_fields = '{"taxId":"20-555-777"}' WHERE id = 'c-ana';
      `);
    },
    async oracle(env) {
      const r = await env.call("crm__get-my-access");
      const access = (r.body as { sensitive?: boolean }).sensitive;
      return access ? "" : "I cannot see Ana Ortega's tax ID: sensitive fields are hidden from my access.";
    },
    async grade(_env, answer) {
      return new Check()
        .that(!/20-555-777|\d{2}-\d{3}-\d{3}/.test(answer), "it gave a tax ID it cannot see")
        .that(CANNOT.test(answer), `it did not say it cannot see it: ${answer.slice(0, 200)}`).grade;
    },
  },
];
