/**
 * Ready-made setups: the generic CRM dressed for one kind of business
 * ============================================================================
 *
 * The kon knows deals, contacts, pipelines and fields; it does not know what a law firm, an agency or a clinic is.
 * A preset is a JSON file in `presets/` that says it: an entity with its fields, a pipeline with stages, the roles
 * people take on a deal, document templates, suggested access profiles and, when kon-conta is installed, the words
 * the ledger shows ("Matter" for a project, "Lawyer" for a resource).
 *
 * Each stage can also bring its automation, so the CRM works the day it is set up: what happens when a deal enters
 * or leaves it (`onEnterActions`, `onExitActions`: a task, an activity, a meeting, logged time, a field), what a
 * deal needs before it may enter (`entryRequirements`) and how many days it should stay (`estimatedDays`). The
 * actions are the stage's own, the same `configure-stage` stores and `move-deal` runs. On a Kitsuden with the
 * rule engine (`ctx.automation`) they become the kon's rules right away, as an edit in the stage editor does. `law-firm.json` is the worked example; a new
 * business is a new file, with no code.
 *
 * Applying twice changes nothing: what exists, by name, stays as the team left it. A preset never grants access by
 * itself, it only suggests the profiles to grant.
 *
 * Two places hold presets:
 *   · `presets/` next to this file: the ones the kon ships (law firm, real estate);
 *   · the folder in `CRM_PRESETS_DIR`, if set: the installation's own. One with the id of a shipped preset replaces
 *     it, so an agency can adjust `real-estate` without forking the kon.
 * A broken file is reported by name (`GET /presets` → `problems`) and skipped: it never hides the others.
 */

import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { createId } from "@paralleldrive/cuid2";
import { and, eq, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { StageActionSchema, StageRequirementsSchema, UPDATABLE } from "./crm.automation";
import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { entityTypes } from "./crm.entitystore";
import { automationOf, stageRuleSlug, syncStageRules } from "./crm.handlers";
import { activityTypeEnum, crmDocumentTemplates, crmPipelineStages, crmPipelines } from "./crm.schema";
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
  stages: z
    .array(
      z.object({
        name: z.string().min(1),
        probability: z.number().int().min(0).max(100),
        estimatedDays: z.number().int().min(0).max(3650).optional().describe("How many days a deal should stay"),
        entryRequirements: StageRequirementsSchema.optional().describe("What a deal needs before it may enter"),
        onEnterActions: z.array(StageActionSchema).max(50).default([]),
        onExitActions: z.array(StageActionSchema).max(50).default([]),
      })
    )
    .min(1),
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

/** Deal columns any preset may name next to its own fields. */
const STANDARD_DEAL_FIELDS = new Set(["title", "value", "currency", "probability", "status", "stageId", "expectedCloseDate", "lostReason", "campaign"]);

/**
 * What the format cannot say: a stage that changes a field a stage may not touch, names a field the preset does not
 * define, or logs time without a quantity. The same things `move-deal` would fail on later, found when the file is read.
 */
export function presetProblem(preset: Preset): string | null {
  const own = new Set(preset.dealFields.map((f) => f.key));
  const names = new Set<string>();
  for (const [index, stage] of preset.stages.entries()) {
    const where = `stages.${index} (${stage.name})`;
    if (names.has(stage.name)) return `${where}: another stage has the same name`;
    names.add(stage.name);
    const requirements = stage.entryRequirements ?? {};
    for (const key of [...(requirements.requiredFields ?? []), ...(requirements.customValidations ?? []).map((v) => v.field)]) {
      if (!own.has(key)) return `${where}: entryRequirements names "${key}", which is not one of the dealFields`;
    }
    for (const [side, actions] of [["onEnterActions", stage.onEnterActions], ["onExitActions", stage.onExitActions]] as const) {
      for (const [n, action] of actions.entries()) {
        const at = `${where}.${side}.${n}`;
        if (action.type === "update_field") {
          const field = action.field ?? "";
          const custom = field.startsWith("custom.") ? field.slice("custom.".length) : null;
          if (custom !== null ? !own.has(custom) : !UPDATABLE.has(field)) {
            return `${at}: update_field may change ${[...UPDATABLE].join(", ")} or custom.<one of the dealFields>, not "${field}"`;
          }
        }
        if (action.type === "log_time" && !(typeof action.value === "number" && action.value > 0)) {
          return `${at}: log_time needs the quantity in value`;
        }
        if ((action.type === "create_task" || action.type === "create_calendar_event") && action.value !== undefined && typeof action.value !== "number") {
          return `${at}: value is the number of days until it is due`;
        }
        const condition = action.condition?.field;
        if (condition) {
          const key = condition.startsWith("custom.") ? condition.slice("custom.".length) : condition;
          if (!own.has(key) && !STANDARD_DEAL_FIELDS.has(key)) return `${at}: the condition names "${condition}", which no deal has`;
        }
      }
    }
  }
  return null;
}

const DIR = fileURLToPath(new URL("./presets/", import.meta.url));

/** Where a preset comes from: shipped with the kon, or the installation's own folder. */
export type PresetOrigin = "shipped" | "installation";

export interface PresetProblem {
  file: string;
  origin: PresetOrigin;
  message: string;
}

export interface CatalogPreset {
  preset: Preset;
  origin: PresetOrigin;
  /** The file it was read from, without its folder. */
  file: string;
  /** An installation preset that took the place of a shipped one with the same id. */
  replacesShipped: boolean;
}

export interface PresetCatalog {
  presets: Map<string, CatalogPreset>;
  problems: PresetProblem[];
}

export interface PresetSource {
  dir: string;
  origin: PresetOrigin;
}

/** A preset is a few kilobytes; anything far bigger is not one. */
const MAX_PRESET_BYTES = 256 * 1024;

/** The installation's own presets folder (`CRM_PRESETS_DIR`), resolved from the working directory, or `null`. */
export function installationPresetsDir(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.CRM_PRESETS_DIR?.trim();
  return raw ? resolve(raw) : null;
}

/** The shipped folder, then the installation's when it is set. */
export function presetSources(env: Record<string, string | undefined> = process.env): PresetSource[] {
  const own = installationPresetsDir(env);
  return [{ dir: DIR, origin: "shipped" }, ...(own ? [{ dir: own, origin: "installation" as const }] : [])];
}

function issueOf(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "not a valid preset";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/**
 * Every preset in `sources`, each file on its own: a file that cannot be read, is not JSON or does not fit the
 * format goes to `problems` with the reason, and the rest load. Files are read in name order; inside one folder
 * the first file with an id wins and a second one is a problem; an installation preset replaces a shipped one.
 */
export function readPresets(sources: PresetSource[] = presetSources()): PresetCatalog {
  const presets = new Map<string, CatalogPreset>();
  const problems: PresetProblem[] = [];
  for (const { dir, origin } of sources) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch (err) {
      problems.push({ file: dir, origin, message: `the folder cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` });
      continue;
    }
    const seenHere = new Set<string>();
    for (const file of files) {
      const path = join(dir, file);
      let raw: string;
      try {
        // One descriptor for the size check and the read: no gap between them (CodeQL js/file-system-race).
        const fd = openSync(path, "r");
        try {
          if (fstatSync(fd).size > MAX_PRESET_BYTES) {
            problems.push({ file, origin, message: `larger than ${MAX_PRESET_BYTES / 1024} KB` });
            continue;
          }
          raw = readFileSync(fd, "utf8");
        } finally {
          closeSync(fd);
        }
      } catch (err) {
        problems.push({ file, origin, message: `cannot be read (${(err as NodeJS.ErrnoException).code ?? "error"})` });
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch (err) {
        problems.push({ file, origin, message: `not valid JSON: ${(err as Error).message}` });
        continue;
      }
      const parsed = Preset.safeParse(json);
      if (!parsed.success) {
        problems.push({ file, origin, message: issueOf(parsed.error) });
        continue;
      }
      const preset = parsed.data;
      const problem = presetProblem(preset);
      if (problem) {
        problems.push({ file, origin, message: problem });
        continue;
      }
      if (seenHere.has(preset.id)) {
        problems.push({ file, origin, message: `another file in the same folder already has the id "${preset.id}"` });
        continue;
      }
      seenHere.add(preset.id);
      const replacesShipped = origin === "installation" && presets.get(preset.id)?.origin === "shipped";
      presets.set(preset.id, { preset, origin, file, replacesShipped });
    }
  }
  return { presets, problems };
}

/**
 * The presets of one folder, strictly: the first broken file throws with its name. For tooling and tests that want
 * a bad file to stop them; the routes use `readPresets`, which skips it.
 */
export function loadPresets(dir = DIR): Map<string, Preset> {
  const { presets, problems } = readPresets([{ dir, origin: "shipped" }]);
  if (problems.length > 0) throw new Error(`Preset ${problems[0].file} is not valid: ${problems[0].message}`);
  return new Map([...presets].map(([id, entry]) => [id, entry.preset]));
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

type PresetStage = Preset["stages"][number];

/** The stage columns a preset stage fills. */
function stageAutomation(stage: PresetStage) {
  return {
    ...(stage.estimatedDays !== undefined ? { estimatedDays: stage.estimatedDays } : {}),
    ...(stage.entryRequirements ? { entryRequirements: stage.entryRequirements } : {}),
    onEnterActions: stage.onEnterActions,
    onExitActions: stage.onExitActions,
  };
}

const isEmpty = (value: unknown) =>
  value === null || value === undefined || (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value as object).length === 0);

/**
 * A pipeline set up by an older version of the preset gets the automation it now brings, stage by stage and only
 * where the stage has none: what the team configured stays as they left it. Returns what it filled and the stages
 * it touched.
 *
 * With the rule engine a stage's actions live in the kon's rules and its columns are empty, so a side counts as
 * configured when either holds them: an empty column next to a rule is the team's work, not a gap to fill.
 */
async function fillStageAutomation(
  db: CrmDb,
  pipelineId: string,
  preset: Preset,
  ruleSlugs: Set<string>
): Promise<{ filled: string[]; stageIds: string[] }> {
  const filled: string[] = [];
  const stageIds: string[] = [];
  const existing = await db
    .select({
      id: crmPipelineStages.id,
      name: crmPipelineStages.name,
      estimatedDays: crmPipelineStages.estimatedDays,
      entryRequirements: crmPipelineStages.entryRequirements,
      onEnterActions: crmPipelineStages.onEnterActions,
      onExitActions: crmPipelineStages.onExitActions,
    })
    .from(crmPipelineStages)
    .where(eq(crmPipelineStages.pipelineId, pipelineId));
  for (const stage of preset.stages) {
    const row = existing.find((s) => s.name === stage.name);
    if (!row) continue;
    const set: Record<string, unknown> = {};
    if (stage.estimatedDays !== undefined && row.estimatedDays === null) set.estimatedDays = stage.estimatedDays;
    if (stage.entryRequirements && isEmpty(row.entryRequirements)) set.entryRequirements = stage.entryRequirements;
    if (stage.onEnterActions.length && isEmpty(row.onEnterActions) && !ruleSlugs.has(stageRuleSlug(row.id, "enter"))) {
      set.onEnterActions = stage.onEnterActions;
    }
    if (stage.onExitActions.length && isEmpty(row.onExitActions) && !ruleSlugs.has(stageRuleSlug(row.id, "exit"))) {
      set.onExitActions = stage.onExitActions;
    }
    if (Object.keys(set).length === 0) continue;
    await db.update(crmPipelineStages).set({ ...set, updatedAt: new Date() }).where(eq(crmPipelineStages.id, row.id));
    filled.push(...Object.keys(set).map((k) => `stage:${stage.name}.${k}`));
    stageIds.push(row.id);
  }
  return { filled, stageIds };
}

export function presetOperations(routes: ReturnType<typeof registry>, ctx?: KonContext): void {
  routes.get(
    "/presets",
    {
      id: "list-presets",
      summary: "List the ready-made setups",
      description:
        "Each preset's id, name, description and `origin` (`shipped` with the kon, or `installation` from the folder in CRM_PRESETS_DIR; an installation preset with a shipped id replaces it). `problems` lists the files that were skipped and why. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: z.object({}).passthrough() },
    },
    async (c) => {
      const { presets, problems } = readPresets();
      return c.json({
        data: [...presets.values()].map(({ preset, origin, replacesShipped }) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          origin,
          replacesShipped,
        })),
        problems,
      });
    }
  );

  routes.post(
    "/presets/:id/apply",
    {
      id: "apply-preset",
      summary: "Set the CRM up for a kind of business",
      description:
        "Creates the preset's entity with its fields, its pipeline with stages (each with what it does when a deal enters or leaves it, what a deal needs to enter and how long it should stay) and its document templates, and gives kon-conta its words if it is installed. What already exists by name stays as it is, so repeating it is safe; a stage the preset now automates and the team never configured gets that automation. Returns what it `created`, the `rules` the stage actions became on a Kitsuden with the rule engine, the deal contact `roles`, the suggested access `profiles` and the `nextSteps`. Admin only. 404 for an unknown preset; see `list-presets`.",
      access: "session",
      permission: CONFIGURE,
      before: [requiresEdit],
      sensitive: true,
      idempotent: true,
      input: { params: ParamPreset },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const preset = readPresets().presets.get(input.params.id)?.preset;
      if (!preset) throw AppError.notFound("Unknown preset");
      const db = dbDe(c);
      const createdBy = userOf(c)?.id ?? null;
      const created: string[] = [];
      const automation = ctx ? automationOf(ctx) : null;
      const ruleSlugs = new Set(automation ? (await automation.listRules(KON_ID)).map((r) => r.slug) : []);
      // The stages whose actions this apply wrote: they go to the rule engine below, when there is one.
      let touchedStages: string[] = [];

      let [pipeline] = await db.select().from(crmPipelines).where(eq(crmPipelines.name, preset.pipeline));
      if (!pipeline) {
        [pipeline] = await db.insert(crmPipelines).values({ name: preset.pipeline, createdBy }).returning();
        for (const [order, stage] of preset.stages.entries()) {
          const [row] = await db
            .insert(crmPipelineStages)
            .values({ pipelineId: pipeline!.id, name: stage.name, order, probability: stage.probability, ...stageAutomation(stage) })
            .returning({ id: crmPipelineStages.id });
          if (stage.onEnterActions.length || stage.onExitActions.length) touchedStages.push(row!.id);
        }
        created.push(`pipeline:${preset.pipeline}`);
      } else {
        const { filled, stageIds } = await fillStageAutomation(db, pipeline.id, preset, ruleSlugs);
        created.push(...filled);
        touchedStages = stageIds;
      }
      // Same as the stage editor: with the rule engine, the actions just written become the kon's rules.
      const rules = ctx && touchedStages.length ? (await syncStageRules(ctx, db, touchedStages)).rules : [];

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
        const store = entityTypes(db);
        const existing = (await store.list()).find((t) => t.konId === KON_ID && t.entityName === entity.entityName);
        if (existing) {
          // What the team set stays; only what is missing is added, so an older install gets the new settings.
          const current = (existing.metadata as Record<string, unknown> | null) ?? {};
          const missing = Object.fromEntries(Object.entries(entity.metadata).filter(([k]) => current[k] === undefined));
          if (Object.keys(missing).length > 0) {
            await store.update(existing.id, { metadata: { ...current, ...missing } });
            created.push(...Object.keys(missing).map((k) => `setting:${entity.entityName}.${k}`));
          }
          continue;
        }
        await store.create({ konId: KON_ID, ...entity, requiresContact: false, requiresCompany: false, isActive: true, createdBy });
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
        rules,
        roles: preset.dealContactRoles,
        profiles: preset.profiles,
        nextSteps: preset.nextSteps,
      });
    }
  );
}
