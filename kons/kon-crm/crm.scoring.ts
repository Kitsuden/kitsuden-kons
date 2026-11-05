/**
 * Contact score: rules anyone can read and change
 * ============================================================================
 *
 *   score = sum of the points of every rule that holds, kept between 0 and 100
 *
 * The rules and a Markdown guide live in the database and an admin edits them from the panel. Each save is
 * a new version, and each contact keeps which rules gave it its points.
 *
 * The number never comes from a model. Agents read the guide to understand the score and can propose rules,
 * but what decides is a calculation that gives the same result every time and can be explained to whoever
 * asks why a contact ranks first.
 */

import { AppError } from "@kitsuden/engine";
import { and, desc, eq, gt, sql, asc } from "drizzle-orm";
import { z } from "zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { crmActivities, crmContacts, crmDeals, crmScoreModels } from "./crm.schema";
import { CONFIGURE, EDIT, VIEW, requiresEdit, type registry } from "./operations";

export const SIGNALS = {
  hasEmail: "The contact has an email",
  corporateEmail: "The email is not from a free provider",
  hasPhone: "The contact has a phone or mobile",
  hasCompany: "The contact is linked to a company",
  hasJobTitle: "The job title is known",
  activities30d: "Activities in the last 30 days",
  openDeals: "Open deals",
  wonDeals: "Won deals",
  daysSinceContact: "Days since the last contact (999 if never)",
  status: "Contact status",
  source: "Where the contact came from",
} as const;

const SIGNAL_KEY = /^custom\.[a-zA-Z0-9_-]{1,100}$/;

const Rule = z.object({
  id: z.string().trim().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  signal: z
    .string()
    .refine((s) => s in SIGNALS || SIGNAL_KEY.test(s), "Unknown signal: see `signals`, or use custom.<field>"),
  op: z.enum(["==", "!=", ">=", "<="]),
  value: z.union([z.string().max(200), z.number(), z.boolean()]),
  points: z.number().int().min(-100).max(100),
});
export type ScoreRule = z.infer<typeof Rule>;
export type Signals = Record<string, unknown>;

const FREE_EMAIL = /@(gmail|googlemail|hotmail|outlook|live|yahoo|ymail|icloud|me|aol|proton|protonmail|gmx|mail)\./i;

export interface ScoreResult {
  score: number;
  /** The rules that held: this is the explanation of the number. */
  matched: { id: string; label: string; points: number }[];
}

function holds(rule: ScoreRule, signals: Signals): boolean {
  const actual = signals[rule.signal];
  if (actual === undefined || actual === null) return false;
  if (rule.op === "==") return actual === rule.value;
  if (rule.op === "!=") return actual !== rule.value;
  const a = Number(actual);
  const b = Number(rule.value);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return rule.op === ">=" ? a >= b : a <= b;
}

export function computeScore(rules: ScoreRule[], signals: Signals): ScoreResult {
  const matched = rules
    .filter((r) => holds(r, signals))
    .map((r) => ({ id: r.id, label: r.label, points: r.points }));
  const total = matched.reduce((sum, r) => sum + r.points, 0);
  return { score: Math.min(100, Math.max(0, total)), matched };
}

type ContactRow = typeof crmContacts.$inferSelect;

export async function signalsOf(db: CrmDb, contact: ContactRow, now = new Date()): Promise<Signals> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [activity] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(crmActivities)
    .where(and(eq(crmActivities.contactId, contact.id), gt(crmActivities.createdAt, since)));
  const [deals] = await db
    .select({
      open: sql<number>`(count(*) FILTER (WHERE ${crmDeals.status} = 'open'))::int`,
      won: sql<number>`(count(*) FILTER (WHERE ${crmDeals.status} = 'won'))::int`,
    })
    .from(crmDeals)
    .where(eq(crmDeals.contactId, contact.id));
  const custom = Object.fromEntries(
    Object.entries((contact.customFields as Record<string, unknown> | null) ?? {}).map(([k, v]) => [`custom.${k}`, v])
  );
  return {
    ...custom,
    hasEmail: !!contact.email,
    corporateEmail: !!contact.email && !FREE_EMAIL.test(contact.email),
    hasPhone: !!(contact.phone || contact.mobile),
    hasCompany: !!contact.companyId,
    hasJobTitle: !!contact.jobTitle,
    activities30d: activity?.count ?? 0,
    openDeals: deals?.open ?? 0,
    wonDeals: deals?.won ?? 0,
    daysSinceContact: contact.lastContactedAt
      ? Math.floor((now.getTime() - new Date(contact.lastContactedAt).getTime()) / 86_400_000)
      : 999,
    status: contact.status,
    source: contact.source,
  };
}

async function currentModel(db: CrmDb) {
  const [model] = await db.select().from(crmScoreModels).orderBy(desc(crmScoreModels.version)).limit(1);
  if (!model) throw AppError.notFound("There is no score model");
  return model;
}

async function scoreAndSave(db: CrmDb, contact: ContactRow, rules: ScoreRule[], version: number) {
  const result = computeScore(rules, await signalsOf(db, contact));
  await db
    .update(crmContacts)
    .set({ score: result.score, scoreVersion: version, scoreBreakdown: result.matched })
    .where(eq(crmContacts.id, contact.id));
  return result;
}

const Output = z.object({}).passthrough();
const SaveModel = z.object({
  rules: z.array(Rule).max(100),
  guide: z.string().trim().min(1).max(20_000).describe("Markdown: how the team reads this score"),
});
const Recalculate = z.object({
  after: z.string().max(100).optional().describe("The `next` of the previous page"),
  limit: z.number().int().min(1).max(500).optional(),
});
const Preview = z.object({ rules: z.array(Rule).max(100).optional() });
const ParamId = z.object({ id: z.string().describe("Contact id") });

export function scoringOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/score-model",
    {
      id: "get-score-model",
      summary: "Read the contact score model",
      description:
        "The rules in force, the Markdown guide, its version and the catalog of `signals` a rule can use (plus `custom.<field>`). Requires CRM view access. Read the guide before interpreting or proposing a score change.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) => c.json({ ...(await currentModel(dbDe(c))), signals: SIGNALS })
  );

  routes.put(
    "/score-model",
    {
      id: "update-score-model",
      summary: "Save a new version of the score model",
      description:
        "Admin only. Saves rules and guide as a new version; earlier versions stay. Existing scores change only on `recalculate-scores`. A rule with an unknown signal answers 422.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      input: { body: SaveModel },
      output: { schema: Output },
    },
    async (c, input) => {
      const [row] = await dbDe(c)
        .insert(crmScoreModels)
        .values({ rules: input.body.rules, guide: input.body.guide, createdBy: userOf(c)?.id ?? null })
        .returning();
      return c.json(row);
    }
  );

  routes.get(
    "/score-model/versions",
    {
      id: "list-score-model-versions",
      summary: "List earlier versions of the score model",
      description: "Newest first, up to 50, with who saved each one. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: Output },
    },
    async (c) =>
      c.json({ data: await dbDe(c).select().from(crmScoreModels).orderBy(desc(crmScoreModels.version)).limit(50) })
  );

  routes.post(
    "/contacts/:id/score",
    {
      id: "score-contact",
      summary: "Calculate one contact's score",
      description:
        "Returns the score and `matched`, the rules that produced it, and saves them. With `rules` it only previews what those rules would give and saves nothing. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { params: ParamId, body: Preview },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const [contact] = await db.select().from(crmContacts).where(eq(crmContacts.id, input.params.id));
      if (!contact) throw AppError.notFound("Contact not found");
      if (input.body?.rules) return c.json(computeScore(input.body.rules, await signalsOf(db, contact)));
      const model = await currentModel(db);
      return c.json(await scoreAndSave(db, contact, model.rules as ScoreRule[], model.version));
    }
  );

  routes.post(
    "/scores/recalculate",
    {
      id: "recalculate-scores",
      summary: "Recalculate contact scores, one page at a time",
      description:
        "Applies the current model to up to `limit` contacts (default 200, at most 500) and returns `next` while more remain: repeat with `after`. Overwrites scores set by hand. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { body: Recalculate },
      output: { schema: Output },
    },
    async (c, input) => {
      const db = dbDe(c);
      const limit = input.body?.limit ?? 200;
      const model = await currentModel(db);
      const contacts = await db
        .select()
        .from(crmContacts)
        .where(input.body?.after ? gt(crmContacts.id, input.body.after) : undefined)
        .orderBy(asc(crmContacts.id))
        .limit(limit);
      for (const contact of contacts) await scoreAndSave(db, contact, model.rules as ScoreRule[], model.version);
      return c.json({
        scored: contacts.length,
        version: model.version,
        next: contacts.length === limit ? contacts[contacts.length - 1]!.id : null,
      });
    }
  );
}
