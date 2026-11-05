/**
 * What an agent needs to work here: a guide, and small groups of tools
 * ============================================================================
 *
 * The CRM has about a hundred operations. A model picks worse among a hundred tools than among ten, so the kon
 * declares groups of operations that go together (`mcpToolsets` in its definition), which an MCP session or an
 * agent asks for as `kon:crm/<group>`. They narrow, never grant: the agent still needs its scopes.
 *
 * The guide is Markdown next to this file (`AGENT_GUIDE.md`), versioned like code, and `get-agent-guide` adds
 * what only this installation knows: its entities and fields, its activity kinds, and what the caller can see.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { accessOf } from "./crm.access";
import { dbDe } from "./crm.context";
import { activityKinds } from "./crm.entities";
import { crmEntityConfigs } from "./crm.schema";
import { VIEW, type registry } from "./operations";

const ORIENT = ["get-agent-guide", "get-my-access", "list-activity-kinds"];

/** Operation ids per group. Every group starts with the guide and the caller's access. */
export const CRM_TOOLSETS: Record<string, string[]> = {
  /** Answering questions about the pipeline and the work, without writing anything: what a chatbot needs. */
  assistant: [
    ...ORIENT,
    "list-deals",
    "get-deal",
    "count-deals",
    "get-board",
    "list-pipelines",
    "get-pipeline",
    "get-deal-history",
    "list-deal-contacts",
    "list-contacts",
    "get-contact",
    "list-companies",
    "get-company",
    "list-activities",
    "list-work",
    "get-work-summary",
    "get-agenda",
    "list-documents",
  ],
  /** Working deals: moving them, tasks, people on them. */
  sales: [
    ...ORIENT,
    "list-deals",
    "get-deal",
    "count-deals",
    "get-board",
    "list-pipelines",
    "get-pipeline",
    "create-deal",
    "update-deal",
    "validate-move",
    "move-deal",
    "get-deal-history",
    "list-deal-contacts",
    "add-deal-contact",
    "list-contacts",
    "get-contact",
    "list-activities",
    "create-activity",
    "update-activity",
    "complete-activity",
    "reopen-activity",
    "list-work",
    "get-work-summary",
    "get-agenda",
  ],
  /** Finding out about people and companies, and recording what was seen. */
  research: [
    ...ORIENT,
    "list-contacts",
    "get-contact",
    "list-companies",
    "get-company",
    "list-activities",
    "find-contact-duplicates",
    "get-evidence-policy",
    "record-observation",
    "list-observations",
    "score-contact",
  ],
  /** Bringing people in: leads, imports, duplicates. */
  intake: [
    ...ORIENT,
    "capture-lead",
    "find-contact-duplicates",
    "merge-contacts",
    "list-merge-requests",
    "list-contacts",
    "get-contact",
    "create-contact",
    "update-contact",
    "list-companies",
    "create-company",
    "list-suppressions",
  ],
  /** Logging work and expenses on deals for the ledger. */
  billing: [...ORIENT, "list-deals", "get-deal", "log-deal-work", "record-deal-expense", "ensure-deal-project"],
};

const GUIDE = fileURLToPath(new URL("./AGENT_GUIDE.md", import.meta.url));

export function agentOperations(routes: ReturnType<typeof registry>): void {
  routes.get(
    "/agent-guide",
    {
      id: "get-agent-guide",
      summary: "Read how to work in this CRM",
      description:
        "Call it first. `guide`: how to read, write and when to stop (Markdown). `business`: this installation's entities with their fields and the activity kinds, its own words for things. `access`: what you can see. `toolsets`: groups of tools to ask for as `kon:crm/<group>`. Requires CRM view access.",
      access: "session",
      permission: VIEW,
      output: { schema: z.object({}).passthrough() },
    },
    async (c) => {
      const db = dbDe(c);
      const entities = await db
        .select({
          name: crmEntityConfigs.entityName,
          singular: crmEntityConfigs.singularLabel,
          plural: crmEntityConfigs.pluralLabel,
          fields: crmEntityConfigs.fieldSchema,
        })
        .from(crmEntityConfigs)
        .where(eq(crmEntityConfigs.isActive, true));
      return c.json({
        data: {
          guide: readFileSync(GUIDE, "utf8"),
          business: {
            entities: entities.map((e) => ({
              ...e,
              fields: (e.fields ?? []).map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options, sensitive: !!f.sensitive })),
            })),
            activityKinds: await activityKinds(db),
          },
          access: await accessOf(db),
          toolsets: CRM_TOOLSETS,
        },
      });
    }
  );
}
