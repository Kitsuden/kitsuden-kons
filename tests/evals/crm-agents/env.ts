/**
 * One eval environment: a fresh CRM, and the tools an agent would see
 * ============================================================================
 *
 * Each (case, attempt) gets its own PGlite with kon-crm's real migrations, as a non-superuser role, and the CRM
 * router mounted the way the host mounts it. Nothing is shared between attempts.
 *
 * The tools are built by the core's own functions (`mcpTool`, `requestFromArguments`), so the agent reads the
 * same names, descriptions and input schemas as through MCP in production, and its calls become the same HTTP
 * requests. The agent acts as an agent identity with `crm:view` and `crm:edit`: by default it sees every record
 * and the amounts, but no notes and no sensitive fields.
 *
 * Not production: there is no approval queue (a 202) and no core tools; what is measured is whether the CRM's
 * own tools, in one of its groups, are enough.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

import { mcpTool, requestFromArguments } from "../../../.kitsuden/apps/api/src/lib/operations-openapi";
import { createTestKonContext } from "../../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../../.kitsuden/tests/unit/helpers/rls-host";
import { CRM_TOOLSETS } from "../../../kons/kon-crm/crm.agents";
import { registerCrmPolicy } from "../../../kons/kon-crm/crm.policy";
import { createCRMRouter, crmOperations } from "../../../kons/kon-crm/crm.routes";
import { dropToAppRole, migratedBase, requestAs, testAuth } from "../../unit/helpers/safe-kons-bench";

export const AGENT_SCOPES = ["crm:view", "crm:edit"];

export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CallResult {
  status: number;
  body: unknown;
  isError: boolean;
}

export interface EvalEnv {
  tools: Tool[];
  /** Calls a tool as the agent would: by name, with its arguments. */
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  /** Reads the database as its owner, outside the agent's access: one statement. */
  sql<T = Record<string, unknown>>(query: string): Promise<T[]>;
  /** Prepares the database as its owner: several statements. */
  exec(statements: string): Promise<void>;
  close(): Promise<void>;
}

export type Toolset = keyof typeof CRM_TOOLSETS;

export async function createEnv(toolset: Toolset): Promise<EvalEnv> {
  const dir = resolve(__dirname, "../../../kons/kon-crm/migrations");
  const client: PGlite = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec("RESET ROLE");
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  registerCrmPolicy();
  const request = requestAs(host.mount(createCRMRouter(ctx)));

  const wanted = new Set(CRM_TOOLSETS[toolset]);
  const ops = crmOperations(createTestKonContext({}) as never).filter((op) => wanted.has((op as { id: string }).id));
  const byName = new Map<string, { op: (typeof ops)[number]; tool: Tool }>();
  for (const op of ops) {
    const tool = mcpTool("kon-crm", "", op as never);
    if (tool) byName.set(tool.name, { op, tool: { name: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema as Record<string, unknown> } });
  }

  return {
    tools: [...byName.values()].map((e) => e.tool),
    async call(name, args = {}) {
      registerCrmPolicy();
      const entry = byName.get(name);
      if (!entry) return { status: 404, body: { error: `Unknown tool ${name}` }, isError: true };
      let built;
      try {
        built = requestFromArguments("", entry.op as never, args);
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message }, isError: true };
      }
      const url = new URL(built.url);
      const res = await request({ agent: AGENT_SCOPES }, built.init.method ?? "GET", url.pathname + url.search, built.init.body as string | undefined);
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON: the agent reads the text.
      }
      return { status: res.status, body, isError: res.status >= 400 };
    },
    async sql<T>(query: string) {
      await client.exec("RESET ROLE");
      try {
        return (await client.query<T>(query)).rows;
      } finally {
        await dropToAppRole(client);
      }
    },
    async exec(statements: string) {
      await client.exec("RESET ROLE");
      try {
        await client.exec(statements);
      } finally {
        await dropToAppRole(client);
      }
    },
    close: () => client.close(),
  };
}

/** The same small business for every case: a pipeline, two companies, three people, three deals. */
export async function seed(env: EvalEnv): Promise<void> {
  await env.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('p1', 'Sales');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order", probability) VALUES
      ('s-lead', 'p1', 'Lead', 0, 10), ('s-proposal', 'p1', 'Proposal', 1, 40),
      ('s-negotiation', 'p1', 'Negotiation', 2, 70), ('s-won', 'p1', 'Won', 3, 100);
    INSERT INTO crm_companies (id, name, domain) VALUES ('co-acme', 'Acme Holdings', 'acme.example'), ('co-beta', 'Beta Labs', 'beta.example');
    INSERT INTO crm_contacts (id, first_name, last_name, email, company_id, phone) VALUES
      ('c-ana', 'Ana', 'Ortega', 'ana@acme.example', 'co-acme', '+51 111'),
      ('c-ana2', 'A.', 'Ortega', 'ana.o@acme.example', 'co-acme', null),
      ('c-bruno', 'Bruno', 'Paz', 'bruno@beta.example', 'co-beta', null);
    INSERT INTO crm_deals (id, title, value, pipeline_id, stage_id, contact_id, company_id) VALUES
      ('d-acme', 'Acme renewal', 12000, 'p1', 's-proposal', 'c-ana', 'co-acme'),
      ('d-beta', 'Beta pilot', 3000, 'p1', 's-proposal', 'c-bruno', 'co-beta'),
      ('d-gamma', 'Gamma expansion', 8000, 'p1', 's-lead', 'c-ana', 'co-acme');
  `);
}
