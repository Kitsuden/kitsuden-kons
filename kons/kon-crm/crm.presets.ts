/**
 * Ready-made setups: the generic CRM dressed for one kind of business
 * ============================================================================
 *
 * The kon knows deals, contacts, pipelines and fields; it does not know what a law firm, an agency or a clinic is.
 * A preset is a JSON file in `presets/` that says it: an entity with its fields, a pipeline with stages, the roles
 * people take on a deal, document templates, suggested access profiles and, when kon-conta is installed, the words
 * the ledger shows ("Matter" for a project, "Lawyer" for a resource). `law-firm.json` is the worked example; a new
 * business is a new file, with no code.
 *
 * Applying twice changes nothing: what exists, by name, stays as the team left it. A preset never grants access by
 * itself, it only suggests the profiles to grant.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AppError } from "@kitsuden/engine";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { activityTypeEnum, crmDocumentTemplates, crmEntityConfigs, crmPipelineStages, crmPipelines } from "./crm.schema";
import { CONFIGURE, KON_ID, VIEW, requiresEdit, type registry } from "./operations";

const Field = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  type: z.enum(["text", "number", "currency", "date", "datetime", "select", "multiselect", "boolean", "email", "url", "file", "contact", "company"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  sensitive: z.boolean().optional(),
  portal: z.boolean().optional(),
});
const Label = z.object({ singular: z.string(), plural: z.string() });

export const Preset = z.object({
  $comment: z.string().optional(),
  id: z.string().regex(/^[a-z0-9-]{2,60}$/),
  name: z.string(),
  description: z.string(),
  entity: z.object({ name: z.string().min(1).max(100), singular: z.string(), plural: z.string() }),
  contactFields: z.array(Field),
  companyFields: z.array(Field).default([]),
  dealFields: z.array(Field),
  numbering: z
    .object({ field: z.string().min(1), prefix: z.string().max(20).optional(), padding: z.number().int().min(1).max(10).optional() })
    .optional()
    .describe("Fill this deal field with the next number when a deal is created"),
  activityKinds: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9-]{1,60}$/),
        label: z.string(),
        type: z.enum(activityTypeEnum.enumValues).optional(),
        defaultDurationMinutes: z.number().int().min(0).max(100_000).optional(),
      })
    )
    .default([]),
  dealContactRoles: z.array(z.string()).default([]),
  pipeline: z.string().min(1),
  stages: z.array(z.object({ name: z.string().min(1), probability: z.number().int().min(0).max(100) })).min(1),
  templates: z.array(z.object({ name: z.string(), description: z.string(), body: z.string() })).default([]),
  profiles: z
    .array(
      z.object({
        profile: z.string(),
        records: z.enum(["all", "assigned"]),
        money: z.boolean(),
        sensitive: z.boolean(),
        notes: z.boolean(),
      })
    )
    .default([]),
  conta: z
    .object({
      labels: z.record(z.string(), Label).optional(),
      billingTypes: z.array(z.string()).optional(),
      projectFields: z
        .object({ billingType: z.string().optional(), category: z.string().optional() })
        .optional()
        .describe("Which deal fields become the project's billing type and category"),
      clientTaxIdField: z.string().optional().describe("The contact and company field that is the client's tax id"),
    })
    .optional(),
  nextSteps: z.array(z.string()).default([]),
});
export type Preset = z.infer<typeof Preset>;

const DIR = fileURLToPath(new URL("./presets/", import.meta.url));

/** Every preset file, validated: a broken file is reported by name instead of half-applied. */
export function loadPresets(dir = DIR): Map<string, Preset> {
  const out = new Map<string, Preset>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const parsed = Preset.safeParse(JSON.parse(readFileSync(`${dir}/${file}`, "utf8")));
    if (!parsed.success) throw new Error(`Preset ${file} is not valid: ${parsed.error.issues[0]?.message ?? ""}`);
    out.set(parsed.data.id, parsed.data);
  }
  return out;
}

interface ContaPresetBridge {
  applyContaPreset(db: unknown, input: { labels?: unknown; billingTypes?: string[] }): Promise<unknown>;
}

const CONTA_BRIDGE = "../kon-conta/conta.bridge";

/** The ledger's words for this business, if kon-conta is installed. Without it the CRM works the same. */
async function applyToConta(db: CrmDb, preset: Preset): Promise<boolean> {
  if (!preset.conta?.labels && !preset.conta?.billingTypes) return false;
  let bridge: ContaPresetBridge;
  try {
    bridge = (await import(/* @vite-ignore */ CONTA_BRIDGE)) as ContaPresetBridge;
  } catch {
    return false;
  }
  if (typeof bridge.applyContaPreset !== "function") return false;
  // The code can be next to this kon without kon-conta being installed here: its tables say whether it is.
  const found = await db.execute(sql`SELECT to_regclass('conta_settings') IS NOT NULL AS installed`);
  const rows = Array.isArray(found) ? found : ((found as { rows?: unknown[] }).rows ?? []);
  if (!(rows[0] as { installed?: boolean } | undefined)?.installed) return false;
  const { asSystem } = await import("@kitsuden/engine");
  const { labels, billingTypes } = preset.conta!;
  await asSystem(() => bridge.applyContaPreset(db, { labels, billingTypes }));
  return true;
}

const ParamPreset = z.object({ id: z.string().describe("Preset id, from `list-presets`") });

export function presetOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/presets",
    {
      id: "list-presets",
      summary: "List the ready-made setups",
      description: "Each preset's id, name and description. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: z.object({}).passthrough() },
    },
    async (c) =>
      c.json({ data: [...loadPresets().values()].map(({ id, name, description }) => ({ id, name, description })) })
  );

  routes.post(
    "/presets/:id/apply",
    {
      id: "apply-preset",
      summary: "Set the CRM up for a kind of business",
      description:
        "Creates the preset's entity with its fields, its pipeline with stages and its document templates, and gives kon-conta its words if it is installed. What already exists by name stays as it is, so repeating it is safe. Returns what it `created`, the deal contact `roles`, the suggested access `profiles` and the `nextSteps`. Admin only. 404 for an unknown preset; see `list-presets`.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      idempotent: true,
      input: { params: ParamPreset },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const preset = loadPresets().get(input.params.id);
      if (!preset) throw AppError.notFound("Unknown preset");
      const db = dbDe(c);
      const createdBy = userOf(c)?.id ?? null;
      const created: string[] = [];

      let [pipeline] = await db.select().from(crmPipelines).where(eq(crmPipelines.name, preset.pipeline));
      if (!pipeline) {
        [pipeline] = await db.insert(crmPipelines).values({ name: preset.pipeline, createdBy }).returning();
        for (const [order, stage] of preset.stages.entries()) {
          await db.insert(crmPipelineStages).values({ pipelineId: pipeline!.id, name: stage.name, order, probability: stage.probability });
        }
        created.push(`pipeline:${preset.pipeline}`);
      }

      const taxId = preset.conta?.clientTaxIdField ? { conta: { taxId: preset.conta.clientTaxIdField } } : {};
      const entities = [
        {
          entityName: preset.entity.name,
          singularLabel: preset.entity.singular,
          pluralLabel: preset.entity.plural,
          fieldSchema: preset.dealFields,
          defaultPipelineId: pipeline!.id,
          allowsValue: true,
          allowsTimeTracking: true,
          metadata: {
            ...(preset.numbering ? { numbering: preset.numbering } : {}),
            ...(preset.conta?.projectFields ? { conta: preset.conta.projectFields } : {}),
          },
        },
        { entityName: "contact", singularLabel: "Contact", pluralLabel: "Contacts", fieldSchema: preset.contactFields, defaultPipelineId: null, allowsValue: false, allowsTimeTracking: false, metadata: taxId },
        ...(preset.companyFields.length
          ? [{ entityName: "company", singularLabel: "Company", pluralLabel: "Companies", fieldSchema: preset.companyFields, defaultPipelineId: null, allowsValue: false, allowsTimeTracking: false, metadata: taxId }]
          : []),
        ...(preset.activityKinds.length
          ? [{ entityName: "activity", singularLabel: "Activity", pluralLabel: "Activities", fieldSchema: [], defaultPipelineId: null, allowsValue: false, allowsTimeTracking: false, metadata: { kinds: preset.activityKinds } }]
          : []),
      ];
      for (const entity of entities) {
        const [existing] = await db
          .select({ id: crmEntityConfigs.id, metadata: crmEntityConfigs.metadata })
          .from(crmEntityConfigs)
          .where(and(eq(crmEntityConfigs.konId, KON_ID), eq(crmEntityConfigs.entityName, entity.entityName)));
        if (existing) {
          // What the team set stays; only what is missing is added, so an older install gets the new settings.
          const current = (existing.metadata as Record<string, unknown> | null) ?? {};
          const missing = Object.fromEntries(Object.entries(entity.metadata).filter(([k]) => current[k] === undefined));
          if (Object.keys(missing).length > 0) {
            await db.update(crmEntityConfigs).set({ metadata: { ...current, ...missing } }).where(eq(crmEntityConfigs.id, existing.id));
            created.push(...Object.keys(missing).map((k) => `setting:${entity.entityName}.${k}`));
          }
          continue;
        }
        await db.insert(crmEntityConfigs).values({ konId: KON_ID, ...entity, requiresContact: false, requiresCompany: false, isActive: true, createdBy });
        created.push(`entity:${entity.entityName}`);
      }

      for (const template of preset.templates) {
        const [existing] = await db
          .select({ id: crmDocumentTemplates.id })
          .from(crmDocumentTemplates)
          .where(eq(crmDocumentTemplates.name, template.name));
        if (existing) continue;
        await db.insert(crmDocumentTemplates).values({ id: createId(), ...template, createdBy });
        created.push(`template:${template.name}`);
      }

      const conta = await applyToConta(db, preset);
      return c.json({
        created,
        conta,
        pipelineId: pipeline!.id,
        roles: preset.dealContactRoles,
        profiles: preset.profiles,
        nextSteps: preset.nextSteps,
      });
    }
  );
}
