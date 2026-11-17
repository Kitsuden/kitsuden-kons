/**
 * kon-dc — the gateway contract has ONE source
 * ============================================================================
 *
 * The zod schemas in dc.contract.ts are the source. Two copies must follow them:
 *
 *   · gateway/contract/*.schema.json — their JSON Schema, committed for the Go side and for anyone
 *     writing another worker. Regenerate with `KON_DC_WRITE_CONTRACT=1 pnpm vitest run
 *     tests/unit/kon-dc-contract.test.ts`.
 *   · gateway/contract.go — the Go structs. Their `json:"..."` tags must be exactly the schema's
 *     properties: a renamed field would otherwise be silently dropped by encoding/json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GATEWAY_CONTRACT_VERSION,
  gatewayContractJsonSchemas,
} from "../../kons/kon-dc/dc.contract";

const GATEWAY = resolve(__dirname, "../../kons/kon-dc/gateway");
const CONTRACT_DIR = resolve(GATEWAY, "contract");

type JsonSchema = { properties?: Record<string, JsonSchema>; items?: JsonSchema; required?: string[] };

const schemas = gatewayContractJsonSchemas() as Record<string, JsonSchema>;

if (process.env.KON_DC_WRITE_CONTRACT === "1") {
  mkdirSync(CONTRACT_DIR, { recursive: true });
  for (const [name, schema] of Object.entries(schemas)) {
    writeFileSync(resolve(CONTRACT_DIR, `${name}.schema.json`), `${JSON.stringify(schema, null, 2)}\n`);
  }
}

/** `type Name struct { ... }` → its json tags, in order. */
function goStructTags(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(/type (\w+) struct \{([\s\S]*?)\n\}/g)) {
    out.set(
      m[1],
      [...m[2].matchAll(/`json:"([^",]+)[^"]*"`/g)].map((t) => t[1])
    );
  }
  return out;
}

const props = (s: JsonSchema | undefined) => Object.keys(s?.properties ?? {}).sort();

describe("kon-dc gateway contract", () => {
  it("the committed JSON Schemas are what the zod schemas generate", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      const file = resolve(CONTRACT_DIR, `${name}.schema.json`);
      expect(existsSync(file), `${name}.schema.json is missing: regenerate it (see header)`).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8")), `${name}.schema.json is stale: regenerate it`).toEqual(schema);
    }
  });

  it("the Go structs carry exactly the schema's fields", () => {
    const go = readFileSync(resolve(GATEWAY, "contract.go"), "utf8");
    const tags = goStructTags(go);
    const batch = schemas["gateway-event-batch"];

    const pairs: Array<[string, JsonSchema | undefined]> = [
      ["GatewayConfig", schemas["gateway-config"]],
      ["GatewayEventBatch", batch],
      ["GatewayEventEnvelope", batch.properties?.events?.items],
      ["GatewayIngestResult", schemas["gateway-ingest-result"]],
    ];
    for (const [struct, schema] of pairs) {
      expect(tags.get(struct)?.slice().sort(), `${struct} in contract.go`).toEqual(props(schema));
    }
  });

  it("the Go worker speaks the same contract version", () => {
    const go = readFileSync(resolve(GATEWAY, "contract.go"), "utf8");
    expect(go).toMatch(new RegExp(`const ContractVersion = ${GATEWAY_CONTRACT_VERSION}\\b`));
  });
});
