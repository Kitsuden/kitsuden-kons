/**
 * One "do not contact" between kon-crm and kon-newsletter
 * ============================================================================
 *
 * Both kons' migrations in one PGlite, and one event bus between them: what one kon emits is handed to the
 * other's listener, the way the host delivers it. Neither kon imports the other.
 *
 * What these tests hold:
 *   - an unsubscribe (or a complaint, or a manual suppression) in the newsletter excludes the address in the
 *     CRM, and an exclusion in the CRM suppresses it in the newsletter;
 *   - a bounce is not an exclusion in the CRM, and a domain is not mirrored to the newsletter;
 *   - nothing loops: what arrived from the other kon is not announced back;
 *   - taking an address off one list removes it from the other only if that is where it came from: a real
 *     unsubscribe survives the CRM removing its entry;
 *   - with only one of the two kons installed, nothing happens and nothing fails.
 */

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { useCrmEvents, emitCrm } from "../../kons/kon-crm/crm.events";
import { listenToNewsletterExclusions, onNewsletterSuppressed } from "../../kons/kon-crm/crm.exclusions";
import { isSuppressed } from "../../kons/kon-crm/crm.intake";
import { listenToCrmExclusions, useNewsletterEvents } from "../../kons/kon-newsletter/newsletter.exclusions";
import { suppress, unsuppress } from "../../kons/kon-newsletter/newsletter.service";

import { AGENT_FUNCTIONS } from "./helpers/safe-kons-bench";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;
const emitted: string[] = [];
const jobs: Promise<unknown>[] = [];

function bus() {
  const handlers = new Map<string, Array<(d: unknown) => void>>();
  return {
    handlers,
    emit(name: string, data: unknown) {
      emitted.push(name);
      for (const h of handlers.get(name) ?? []) h(data);
    },
    on(name: string, h: (d: unknown) => void) {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
    },
  };
}

const ctxOn = (events: ReturnType<typeof bus>) =>
  ({
    events,
    db: { instance: db, asSystem: <T>(f: () => Promise<T>) => f(), background: (f: () => Promise<unknown>) => jobs.push(f()) },
    logger: { warn: () => undefined, info: () => undefined, error: () => undefined },
  }) as never;

const settle = async () => {
  while (jobs.length) await jobs.shift();
};

async function lists() {
  const crm = (await pg.query<{ kind: string; value: string; created_by: string | null }>(`SELECT kind, value, created_by FROM crm_suppressions ORDER BY value`)).rows;
  const nl = (await pg.query<{ email: string; reason: string; source: string }>(`SELECT email, reason, source FROM nl_suppressions ORDER BY email`)).rows;
  return { crm, nl };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(AGENT_FUNCTIONS, "utf8"));
  const crmDir = resolve(__dirname, "../../kons/kon-crm/migrations");
  for (const f of readdirSync(crmDir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(resolve(crmDir, f), "utf8"));
  const nlDir = resolve(__dirname, "../../kons/kon-newsletter/migrations");
  for (const f of readdirSync(nlDir).filter((x) => x.endsWith(".sql")).sort()) await pg.exec(readFileSync(resolve(nlDir, f), "utf8"));
  db = drizzle(pg);
});

afterAll(async () => {
  useCrmEvents(undefined);
  useNewsletterEvents(null);
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec("DELETE FROM crm_suppressions; DELETE FROM nl_suppressions;");
  emitted.length = 0;
});

describe("with both kons installed", () => {
  let events: ReturnType<typeof bus>;

  beforeEach(() => {
    events = bus();
    useCrmEvents(events as never);
    useNewsletterEvents(events);
    listenToNewsletterExclusions(ctxOn(events));
    listenToCrmExclusions(ctxOn(events));
  });

  it("an unsubscribe in the newsletter excludes the address in the CRM, once, with no echo", async () => {
    await suppress(db, "Ana@Example.com", "unsubscribe", "local");
    await suppress(db, "ana@example.com", "unsubscribe", "local");
    await settle();
    const { crm, nl } = await lists();
    expect(crm).toEqual([{ kind: "email", value: "ana@example.com", created_by: "kon-newsletter" }]);
    expect(nl).toHaveLength(1);
    expect(await isSuppressed(db, "ana@example.com")).toBe(true);
    // Announced once, and the CRM did not announce it back.
    expect(emitted).toEqual(["newsletter:address.suppressed"]);
  });

  it("a complaint and a manual suppression count too; a bounce does not", async () => {
    await suppress(db, "spam@example.com", "complaint", "mailgun");
    await suppress(db, "hand@example.com", "manual", "admin");
    await suppress(db, "dead@example.com", "bounce", "mailgun");
    await settle();
    expect((await lists()).crm.map((r) => r.value)).toEqual(["hand@example.com", "spam@example.com"]);
  });

  it("an exclusion in the CRM suppresses the address in the newsletter; a domain is not mirrored", async () => {
    await pg.exec(`INSERT INTO crm_suppressions (kind, value) VALUES ('email', 'luis@example.com'), ('domain', 'blocked.example')`);
    emitCrm("address.suppressed", { kind: "email", value: "luis@example.com" });
    emitCrm("address.suppressed", { kind: "domain", value: "blocked.example" });
    await settle();
    expect((await lists()).nl).toEqual([{ email: "luis@example.com", reason: "manual", source: "kon-crm" }]);
    expect(emitted.filter((e) => e.startsWith("newsletter:"))).toEqual([]);
  });

  it("removing it in the CRM lifts only what the CRM put there: a real unsubscribe stays", async () => {
    // Luis: excluded in the CRM only. Ana: unsubscribed herself, and is also on the CRM's list.
    emitCrm("address.suppressed", { kind: "email", value: "luis@example.com" });
    await suppress(db, "ana@example.com", "unsubscribe", "local");
    await settle();
    emitCrm("address.unsuppressed", { kind: "email", value: "luis@example.com" });
    emitCrm("address.unsuppressed", { kind: "email", value: "ana@example.com" });
    await settle();
    expect((await lists()).nl).toEqual([{ email: "ana@example.com", reason: "unsubscribe", source: "local" }]);
  });

  it("removing it in the newsletter lifts only what the newsletter put in the CRM", async () => {
    await pg.exec(`INSERT INTO crm_suppressions (kind, value, created_by) VALUES ('email', 'person@example.com', 'u-admin')`);
    await suppress(db, "person@example.com", "manual", "admin");
    await suppress(db, "other@example.com", "manual", "admin");
    await settle();
    await unsuppress(db, "person@example.com");
    await unsuppress(db, "other@example.com");
    await settle();
    // The person a CRM admin excluded stays excluded; the one only the newsletter put there is free.
    expect((await lists()).crm).toEqual([{ kind: "email", value: "person@example.com", created_by: "u-admin" }]);
  });

  it("listens once per bus, even when started twice", () => {
    listenToNewsletterExclusions(ctxOn(events));
    listenToCrmExclusions(ctxOn(events));
    for (const name of ["newsletter:address.suppressed", "newsletter:address.unsuppressed", "crm:address.suppressed", "crm:address.unsuppressed"]) {
      expect(events.handlers.get(name)).toHaveLength(1);
    }
  });
});

describe("with only one of them", () => {
  it("the newsletter alone suppresses and announces to nobody; nothing fails", async () => {
    const events = bus();
    useNewsletterEvents(events);
    useCrmEvents(undefined);
    await suppress(db, "solo@example.com", "unsubscribe", "local");
    await settle();
    const { crm, nl } = await lists();
    expect(nl).toHaveLength(1);
    expect(crm).toEqual([]);
  });

  it("a malformed event is ignored", async () => {
    expect(await onNewsletterSuppressed(db, { email: "not-an-address" })).toBe(false);
    expect(await onNewsletterSuppressed(db, null)).toBe(false);
  });
});
