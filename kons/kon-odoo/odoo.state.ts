/**
 * Odoo — what every part of the kon reads: the settings row, the capabilities, the secrets
 * ============================================================================
 */

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq } from "drizzle-orm";

import type { OdooClient } from "./odoo.client";
import { companyCurrency, detectCapabilities, KON_ID, odooClient } from "./odoo.connection";
import type { OdooDb } from "./odoo.mirror";
import { odooSettings, type OdooCapabilities, type OdooSettings, type SealedValue } from "./odoo.schema";

export const QUEUES = {
  /** Odoo → mirror: reading what changed */
  sync: "kon-odoo-sync",
  /** Kitsuden → outside: orders to Odoo, purge notices to the site */
  push: "kon-odoo-push",
} as const;

export const dbOf = (ctx: KonContext): OdooDb => ctx.db.instance as OdooDb;

/** The one settings row. The migration creates it; a missing row means the kon is not migrated. */
export async function loadSettings(db: OdooDb): Promise<OdooSettings> {
  const [row] = await db.select().from(odooSettings).where(eq(odooSettings.id, 1)).limit(1);
  if (!row) throw AppError.internal("kon-odoo has no settings row: run its migrations");
  return row;
}

/**
 * What the instance has, from the settings row or, the first time and on demand, from Odoo.
 * Also reads the company currency, which the prices need and no product record carries.
 */
export async function capabilitiesOf(
  db: OdooDb,
  client: OdooClient,
  options: { refresh?: boolean; settings?: OdooSettings } = {}
): Promise<{ capabilities: OdooCapabilities; currency: string | null }> {
  const settings = options.settings ?? (await loadSettings(db));
  if (settings.capabilities && !options.refresh) {
    return { capabilities: settings.capabilities, currency: settings.currency };
  }
  const capabilities = await detectCapabilities(client);
  const currency = (await companyCurrency(client)) ?? settings.currency;
  await db
    .update(odooSettings)
    .set({ capabilities, currency, updatedAt: new Date() })
    .where(eq(odooSettings.id, 1));
  return { capabilities, currency };
}

/**
 * A client that asks for translatable fields in the language the settings name. `purpose` goes
 * to the host's audit of the credential's use.
 */
export async function clientFor(ctx: KonContext, purpose: string): Promise<OdooClient> {
  const settings = await loadSettings(dbOf(ctx));
  return odooClient(ctx, purpose, settings.lang);
}

interface SecretsBattery {
  seal(konId: string, plaintext: string): SealedValue;
  open(konId: string, sealed: SealedValue, access: { purpose: string; subject?: string }): Promise<string>;
}

const secretsOf = (ctx: KonContext): SecretsBattery | null =>
  (ctx as unknown as { secrets?: SecretsBattery }).secrets ?? null;

/** Seals a secret for storage. Without the host's secrets key there is nowhere safe to keep it. */
export function sealSecret(ctx: KonContext, plaintext: string): SealedValue {
  const secrets = secretsOf(ctx);
  if (!secrets) {
    throw AppError.conflict("This Kitsuden has no secrets key configured: the secret cannot be stored.");
  }
  return secrets.seal(KON_ID, plaintext);
}

interface Opened {
  value: string;
  until: number;
}
const opened = new WeakMap<object, Map<string, Opened>>();

/**
 * Opens a sealed secret. Every opening is written to the host's audit, and a webhook can arrive
 * many times a second, so an opened value is kept for a minute, per host context, keyed by the
 * sealed value itself: storing a new secret is a new key, and the old one is simply not found.
 */
export async function openSecret(
  ctx: KonContext,
  sealed: SealedValue | null,
  purpose: string
): Promise<string | null> {
  if (!sealed) return null;
  const secrets = secretsOf(ctx);
  if (!secrets) return null;

  let cache = opened.get(secrets);
  if (!cache) opened.set(secrets, (cache = new Map()));
  const key = `${sealed.iv}:${sealed.authTag}`;
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;

  const value = await secrets.open(KON_ID, sealed, { purpose });
  cache.clear();
  cache.set(key, { value, until: Date.now() + 60_000 });
  return value;
}
