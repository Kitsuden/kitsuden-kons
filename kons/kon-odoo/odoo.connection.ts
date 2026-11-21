/**
 * Odoo — the connection, and what this instance has installed
 * ============================================================================
 *
 * The API key is not this kon's to hold. An admin stores it as an ORGANIZATION connection
 * (`POST /api/connections/api-keys`, provider `odoo`); the host seals it, opens it only to make
 * a request, and adds it itself, and only to the Odoo host. This kon gets a `fetch` that
 * already carries it.
 *
 * Where Odoo is comes from the environment, because the host fixes the hosts a credential may
 * travel to when the provider is registered, at startup:
 *
 *   ODOO_URL=https://erp.example.com          required
 *   ODOO_DATABASE=shop                        only when the server hosts several databases
 *
 * An Odoo on a private address (`http://odoo:8069`, `10.0.4.12`) must also be listed by the
 * operator in the host's `CONNECTIONS_PRIVATE_HOSTS`; otherwise registration is refused.
 */

import type { KonContext } from "@kitsuden/shared";

import { createOdooClient, OdooError, type OdooClient } from "./odoo.client";
import type { OdooCapabilities } from "./odoo.schema";

export const KON_ID = "kon-odoo";
export const PROVIDER = "odoo";

export interface OdooLocation {
  baseUrl: string;
  host: string;
  database: string | null;
}

/** Where Odoo is, or why the setting cannot be used. */
export function odooLocation(
  env: Record<string, string | undefined> = process.env
): OdooLocation | { problem: string } {
  const raw = env.ODOO_URL?.trim();
  if (!raw) return { problem: "ODOO_URL is not set" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: "ODOO_URL is not a URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { problem: "ODOO_URL must be http or https" };
  }
  if (url.username || url.password) return { problem: "ODOO_URL must not carry credentials" };
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    host: url.hostname.toLowerCase(),
    database: env.ODOO_DATABASE?.trim() || null,
  };
}

/** The host's `ctx.connections`, structurally: the kon builds against a host without it. */
interface ConnectionsBattery {
  registerProvider(
    konId: string,
    provider: {
      id: string;
      name: string;
      authTypes: ["api_key"];
      scopeSets: Record<string, never>;
      apiHosts: string[];
      apiKeyHeader?: { name: string; prefix?: string };
    }
  ): void;
  client(
    konId: string,
    request: { provider: string; purpose: string }
  ): Promise<{ fetch(url: string, init?: RequestInit): Promise<Response> }>;
}

function batteryOf(ctx: KonContext): ConnectionsBattery | null {
  const c = (ctx as unknown as { connections?: Partial<ConnectionsBattery> }).connections;
  return c && typeof c.client === "function" && typeof c.registerProvider === "function"
    ? (c as ConnectionsBattery)
    : null;
}

/** Why Odoo cannot be reached from here. The message is for a person setting it up. */
export class OdooNotConnected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OdooNotConnected";
  }
}

let registered = false;

/**
 * Tells the host that a provider called `odoo` exists and which host its key may go to.
 * Returns the problem, if any, so startup can say it once instead of failing every job.
 */
export function registerOdooProvider(ctx: KonContext, env = process.env): string | null {
  const battery = batteryOf(ctx);
  if (!battery) return "this Kitsuden has no connections battery";
  const location = odooLocation(env);
  if ("problem" in location) return location.problem;
  try {
    battery.registerProvider(KON_ID, {
      id: PROVIDER,
      name: "Odoo",
      authTypes: ["api_key"],
      scopeSets: {},
      apiHosts: [location.host],
      // Odoo's JSON-2 API: `Authorization: bearer <key>`.
      apiKeyHeader: { name: "Authorization", prefix: "bearer " },
    });
    registered = true;
    return null;
  } catch (error) {
    registered = false;
    return error instanceof Error ? error.message : String(error);
  }
}

type ClientFactory = (ctx: KonContext, purpose: string) => Promise<OdooClient>;
let factory: ClientFactory | null = null;

/** Tests answer for Odoo here. `null` puts the real connection back. */
export function setOdooClientForTests(next: ClientFactory | null): void {
  factory = next;
}

/**
 * A client for this instance's Odoo. `purpose` is written to the host's audit of every time
 * the credential is used: say what the call is for.
 */
export async function odooClient(ctx: KonContext, purpose: string, lang?: string | null): Promise<OdooClient> {
  if (factory) return factory(ctx, purpose);

  const battery = batteryOf(ctx);
  if (!battery) throw new OdooNotConnected("This Kitsuden has no connections battery.");
  const location = odooLocation();
  if ("problem" in location) throw new OdooNotConnected(`${location.problem}.`);
  if (!registered) {
    const problem = registerOdooProvider(ctx);
    if (problem) throw new OdooNotConnected(problem);
  }

  let connection: { fetch(url: string, init?: RequestInit): Promise<Response> };
  try {
    connection = await battery.client(KON_ID, { provider: PROVIDER, purpose });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OdooNotConnected(`No usable Odoo connection: ${reason}`);
  }

  return createOdooClient({
    baseUrl: location.baseUrl,
    database: location.database ?? undefined,
    transport: (url, init) => connection.fetch(url, init),
    context: lang ? { lang } : undefined,
  });
}

// ── Capabilities ──────────────────────────────────────────────────────────────

/** Fields the sync would like from each model. It asks only for the ones that exist. */
export const WANTED: Record<string, string[]> = {
  "product.template": [
    "name",
    "description_sale",
    "list_price",
    "default_code",
    "barcode",
    "categ_id",
    "active",
    "sale_ok",
    "write_date",
    "currency_id",
    "type",
    "is_storable",
    "is_published",
  ],
  "product.product": [
    "product_tmpl_id",
    "default_code",
    "barcode",
    "lst_price",
    "active",
    "write_date",
    "product_template_attribute_value_ids",
    "free_qty",
    "qty_available",
  ],
  "product.category": ["name", "parent_id", "parent_path"],
  "res.partner": ["name", "email", "phone", "vat"],
  "sale.order": [
    "name",
    "state",
    "partner_id",
    "date_order",
    "client_order_ref",
    "amount_untaxed",
    "amount_tax",
    "amount_total",
    "currency_id",
    "order_line",
    "access_url",
    "access_token",
  ],
  "sale.order.line": [
    "name",
    "product_id",
    "product_uom_qty",
    "price_unit",
    "price_subtotal",
    "price_total",
    "display_type",
  ],
  "account.payment": [
    "amount",
    "currency_id",
    "partner_id",
    "date",
    "state",
    "payment_type",
    "memo",
    "ref",
    "reconciled_invoice_ids",
  ],
  "loyalty.card": ["points", "expiration_date", "program_id", "partner_id"],
};

/** The bridge module's model: one method that does what must happen together. */
export const BRIDGE_MODEL = "kitsuden.bridge";

/**
 * A model's fields, or null when this instance does not have the model or the key's user may
 * not see it. A silence from Odoo is not an answer: that one is thrown.
 */
async function fieldsOf(client: OdooClient, model: string): Promise<string[] | null> {
  try {
    return Object.keys(await client.fieldsGet(model));
  } catch (error) {
    if (error instanceof OdooError && !error.retryable && error.kind !== "auth") return null;
    throw error;
  }
}

/** Asks the instance what it has. Several calls: done at startup and on demand, never per request. */
export async function detectCapabilities(client: OdooClient): Promise<OdooCapabilities> {
  const fields: Record<string, string[]> = {};
  for (const [model, wanted] of Object.entries(WANTED)) {
    const present = await fieldsOf(client, model);
    if (present) {
      const set = new Set(present);
      fields[model] = wanted.filter((name) => set.has(name));
    }
  }
  // A missing optional module is an answer. Missing products is not: without them every
  // switch below would read as "not installed", and a catalog synced on that belief would
  // publish what Odoo keeps hidden. Better no capabilities than wrong ones.
  for (const model of ["product.template", "product.product"]) {
    if (!fields[model]) {
      throw new OdooError({
        kind: "access",
        status: 403,
        message: `The Odoo key's user cannot read ${model}: give it access to products.`,
        model,
        method: "fields_get",
      });
    }
  }
  const has = (model: string, field: string) => fields[model]?.includes(field) ?? false;

  return {
    stock: has("product.product", "free_qty"),
    website: has("product.template", "is_published"),
    variants: has("product.product", "product_template_attribute_value_ids"),
    loyalty: !!fields["loyalty.card"],
    payments: !!fields["account.payment"],
    bridge: (await fieldsOf(client, BRIDGE_MODEL)) !== null,
    fields,
    checkedAt: new Date().toISOString(),
  };
}

/** ISO 4217 of the company the key's user works in, or null when it cannot be read. */
export async function companyCurrency(client: OdooClient): Promise<string | null> {
  try {
    const [company] = await client.searchRead<{ currency_id: [number, string] | false }>(
      "res.company",
      { fields: ["currency_id"], limit: 1, order: "id" }
    );
    const currency = company?.currency_id;
    const code = Array.isArray(currency) ? currency[1] : null;
    return code && /^[A-Z]{3}$/.test(code) ? code : null;
  } catch (error) {
    if (error instanceof OdooError && !error.retryable) return null;
    throw error;
  }
}
