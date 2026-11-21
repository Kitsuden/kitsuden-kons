/**
 * kon-odoo's test bench
 * ============================================================================
 *
 * The kon's migration on PGlite as a NON-superuser role, the host's per-request RLS transaction,
 * and doubles for everything outside: Odoo itself (`FakeOdoo`, an in-memory instance that answers
 * the calls the kon makes), the queue (jobs are recorded and `drain()` runs them through the
 * kon's real handlers), sealed secrets, storage, events and the site that receives purge notices.
 * No network, no Docker.
 */

import type { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";

import { createTestKonContext } from "../../../.kitsuden/apps/api/src/lib/test-kon-context";
import { configureQueue, queueHandlers, type QueueJob } from "../../../.kitsuden/packages/engine/src/queue";
import { rlsHost } from "../../../.kitsuden/tests/unit/helpers/rls-host";
import { OdooError, type OdooClient, type OdooDomain } from "../../../kons/kon-odoo/odoo.client";
import { setOdooClientForTests, WANTED } from "../../../kons/kon-odoo/odoo.connection";
import { registerOdooPolicy } from "../../../kons/kon-odoo/odoo.policy";
import { registerOdooQueues } from "../../../kons/kon-odoo/odoo.queues";
import { createOdooRouter } from "../../../kons/kon-odoo/odoo.routes";
import { setPurgeNetworkForTests, signBody, SIGNATURE_HEADER } from "../../../kons/kon-odoo/odoo.webhook";

import { APP_ROLE, dropToAppRole, migratedBase, requestAs, testAuth } from "./safe-kons-bench";

export const WEBHOOK_SECRET = "webhook-secret-0123456789abcdef";
export const PURGE_SECRET = "purge-secret-0123456789abcdef00";

type Row = Record<string, unknown> & { id: number };

/** An Odoo that lives in memory and answers only what kon-odoo asks. */
export class FakeOdoo implements OdooClient {
  models: Record<string, Row[]> = {};
  /** Models this instance "has installed", with their fields. Absent: the model does not exist. */
  installed: Record<string, string[]> = { ...WANTED, "res.company": ["currency_id"], "res.country": ["code"] };
  calls: Array<{ model: string; method: string; args: unknown }> = [];
  /** Thrown by the next call, once. */
  failNext: OdooError | null = null;
  private sequence = 1000;

  nextId(): number {
    return ++this.sequence;
  }

  add(model: string, ...rows: Row[]): void {
    (this.models[model] ??= []).push(...rows);
  }

  find(model: string, id: number): Row | undefined {
    return this.models[model]?.find((row) => row.id === id);
  }

  remove(model: string, id: number): void {
    this.models[model] = (this.models[model] ?? []).filter((row) => row.id !== id);
  }

  private record(model: string, method: string, args: unknown): void {
    this.calls.push({ model, method, args });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
    if (!this.installed[model] && model !== "product.template.attribute.value" && model !== "account.move") {
      throw new OdooError({ kind: "not-found", status: 404, message: `No model ${model}`, model, method });
    }
  }

  private matches(row: Row, domain: OdooDomain, activeTest: boolean): boolean {
    if (activeTest && row.active === false) return false;
    return domain.every((leaf) => {
      if (typeof leaf === "string") return true;
      const [field, operator, value] = leaf;
      const raw = row[field];
      const actual = Array.isArray(raw) && typeof raw[0] === "number" && typeof raw[1] === "string" ? raw[0] : raw;
      switch (operator) {
        case "=":
          return actual === value;
        case "=ilike":
          return String(actual ?? "").toLowerCase() === String(value).toLowerCase();
        case "in":
          return (value as unknown[]).includes(actual);
        case ">":
          return Number(actual) > Number(value);
        default:
          throw new Error(`FakeOdoo: operator ${operator} is not implemented`);
      }
    });
  }

  private pick(row: Row, fields: string[]): Row {
    const out: Row = { id: row.id };
    for (const field of fields) if (field in row) out[field] = row[field];
    return out;
  }

  /** What the bridge module was asked to do, in order. */
  bridgeCalls: Array<{ method: string; args: Record<string, unknown> }> = [];

  async call<T>(
    model: string,
    method: string,
    args: Record<string, unknown> = {},
    options: { ids?: number[] } = {}
  ): Promise<T> {
    this.record(model, method, { ...args, ids: options.ids });
    const state = (ids: number[] | undefined, value: string) => {
      for (const id of ids ?? []) {
        const order = this.find("sale.order", id);
        if (!order) throw new OdooError({ kind: "missing", status: 404, message: `No order ${id}`, model, method });
        order.state = value;
      }
      return true as T;
    };
    if (model === "sale.order" && method === "action_confirm") return state(options.ids, "sale");
    if (model === "sale.order" && method === "action_cancel") return state(options.ids, "cancel");
    if (model === "kitsuden.bridge" && method === "confirm_payment") {
      this.bridgeCalls.push({ method, args });
      return state([args.order_id as number], "sale");
    }
    throw new Error(`FakeOdoo: ${model}.${method} is not implemented`);
  }

  async searchRead<T>(
    model: string,
    query: { domain?: OdooDomain; fields: string[]; limit?: number; context?: Record<string, unknown> }
  ): Promise<T[]> {
    this.record(model, "search_read", query);
    const rows = (this.models[model] ?? [])
      .filter((row) => this.matches(row, query.domain ?? [], query.context?.active_test !== false))
      .sort((a, b) => a.id - b.id);
    return (query.limit ? rows.slice(0, query.limit) : rows).map((row) => this.pick(row, query.fields)) as T[];
  }

  async searchCount(model: string, domain: OdooDomain = []): Promise<number> {
    this.record(model, "search_count", domain);
    return (this.models[model] ?? []).filter((row) => this.matches(row, domain, true)).length;
  }

  async read<T>(model: string, ids: number[], fields: string[]): Promise<T[]> {
    this.record(model, "read", { ids, fields });
    return (this.models[model] ?? []).filter((row) => ids.includes(row.id)).map((row) => this.pick(row, fields)) as T[];
  }

  async fieldsGet(model: string): Promise<Record<string, { type: string }>> {
    this.record(model, "fields_get", {});
    return Object.fromEntries((this.installed[model] ?? []).map((field) => [field, { type: "char" }]));
  }

  async create(model: string, values: Record<string, unknown>): Promise<number> {
    this.record(model, "create", values);
    const id = this.nextId();
    if (model === "sale.order") {
      const lineIds: number[] = [];
      let untaxed = 0;
      for (const command of (values.order_line as Array<[number, number, Record<string, number>]>) ?? []) {
        const line = command[2];
        const product = this.find("product.product", line.product_id);
        const price = Number(product?.lst_price ?? 0);
        const subtotal = price * line.product_uom_qty;
        const lineId = this.nextId();
        this.add("sale.order.line", {
          id: lineId,
          name: String(product?.display_name ?? `Product ${line.product_id}`),
          product_id: [line.product_id, "x"],
          product_uom_qty: line.product_uom_qty,
          price_unit: price,
          price_subtotal: subtotal,
          price_total: subtotal,
          display_type: false,
        });
        lineIds.push(lineId);
        untaxed += subtotal;
      }
      this.add("sale.order", {
        id,
        name: `S${String(id).padStart(5, "0")}`,
        state: "draft",
        partner_id: [values.partner_id as number, "x"],
        date_order: "2026-11-20 10:00:00",
        client_order_ref: values.client_order_ref ?? false,
        amount_untaxed: untaxed,
        amount_tax: 0,
        amount_total: untaxed,
        currency_id: [1, "USD"],
        order_line: lineIds,
        access_url: `/my/orders/${id}`,
        access_token: "portal-token",
      });
    } else {
      this.add(model, { ...values, id });
    }
    return id;
  }

  async write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
    this.record(model, "write", { ids, values });
    for (const row of this.models[model] ?? []) if (ids.includes(row.id)) Object.assign(row, values);
    return true;
  }
}

/** A shirt in two colours with stock, and a service nobody counts. */
export function seedShop(odoo: FakeOdoo): void {
  odoo.add("res.company", { id: 1, currency_id: [1, "USD"] });
  odoo.add("res.country", { id: 170, code: "PA" });
  odoo.add(
    "product.category",
    { id: 1, name: "All", parent_id: false, parent_path: "1/" },
    { id: 5, name: "Clothing", parent_id: [1, "All"], parent_path: "1/5/" },
    { id: 9, name: "Services", parent_id: [1, "All"], parent_path: "1/9/" }
  );
  odoo.add(
    "product.template",
    {
      id: 10,
      name: "Camiseta Básica",
      description_sale: "Algodón",
      list_price: 19.99,
      default_code: false,
      barcode: false,
      categ_id: [5, "All / Clothing"],
      active: true,
      sale_ok: true,
      write_date: "2026-11-20 09:00:00",
      currency_id: [1, "USD"],
      type: "consu",
      is_storable: true,
      is_published: true,
    },
    {
      id: 11,
      name: "Gift wrapping",
      description_sale: false,
      list_price: 3,
      default_code: "WRAP",
      barcode: false,
      categ_id: [9, "All / Services"],
      active: true,
      sale_ok: true,
      write_date: "2026-11-20 09:00:00",
      currency_id: [1, "USD"],
      type: "service",
      is_storable: false,
      is_published: true,
    },
    {
      id: 12,
      name: "Unreleased hoodie",
      description_sale: false,
      list_price: 50,
      default_code: "HOOD",
      barcode: false,
      categ_id: [5, "All / Clothing"],
      active: true,
      sale_ok: true,
      write_date: "2026-11-20 09:00:00",
      currency_id: [1, "USD"],
      type: "consu",
      is_storable: true,
      is_published: false,
    }
  );
  odoo.add(
    "product.template.attribute.value",
    { id: 501, attribute_id: [1, "Color"], name: "Red" },
    { id: 502, attribute_id: [1, "Color"], name: "Blue" }
  );
  odoo.add(
    "product.product",
    {
      id: 100,
      display_name: "Camiseta Básica (Red)",
      product_tmpl_id: [10, "Camiseta Básica"],
      default_code: "TEE-RED",
      barcode: false,
      lst_price: 19.99,
      active: true,
      write_date: "2026-11-20 09:00:00",
      product_template_attribute_value_ids: [501],
      free_qty: 4,
      qty_available: 5,
    },
    {
      id: 101,
      display_name: "Camiseta Básica (Blue)",
      product_tmpl_id: [10, "Camiseta Básica"],
      default_code: "TEE-BLUE",
      barcode: false,
      lst_price: 21.5,
      active: true,
      write_date: "2026-11-20 09:00:00",
      product_template_attribute_value_ids: [502],
      free_qty: 0,
      qty_available: 2,
    },
    {
      id: 110,
      display_name: "Gift wrapping",
      product_tmpl_id: [11, "Gift wrapping"],
      default_code: "WRAP",
      barcode: false,
      lst_price: 3,
      active: true,
      write_date: "2026-11-20 09:00:00",
      product_template_attribute_value_ids: [],
      free_qty: 0,
      qty_available: 0,
    },
    {
      id: 120,
      display_name: "Unreleased hoodie",
      product_tmpl_id: [12, "Unreleased hoodie"],
      default_code: "HOOD",
      barcode: false,
      lst_price: 50,
      active: true,
      write_date: "2026-11-20 09:00:00",
      product_template_attribute_value_ids: [],
      free_qty: 9,
      qty_available: 9,
    }
  );
}

export async function odooBench() {
  process.env.ODOO_URL = "https://erp.test";
  const client: PGlite = await migratedBase("kon-odoo", ["0000_initial.sql", "0001_cart_holds_payments.sql"]);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);

  const jobs: Array<{ queue: string; name: string; payload: unknown; attempts: number }> = [];
  configureQueue({
    dispatch: async (queue, name, payload, options) => {
      jobs.push({ queue, name, payload, attempts: options.attempts ?? 3 });
      return { id: `q-${jobs.length}` };
    },
  });

  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  const listeners = new Map<string, Array<(d: unknown) => void>>();
  const files = new Map<string, Buffer>();
  const opened: string[] = [];
  const logs: Array<{ level: string; message: string }> = [];

  const ctx = createTestKonContext({
    db: host.db as never,
    auth: auth as never,
    events: {
      emit: (name: string, data: unknown) => {
        events.push({ name, data: data as Record<string, unknown> });
        for (const fn of listeners.get(name) ?? []) fn(data);
      },
      on: (name: string, fn: (d: unknown) => void) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    },
    secrets: {
      seal: (konId: string, plaintext: string) => ({
        v: 1,
        kon: konId,
        valueEncrypted: Buffer.from(plaintext).toString("base64"),
        iv: `iv-${plaintext.length}-${plaintext.slice(0, 6)}`,
        authTag: "tag",
      }),
      open: async (konId: string, sealed: { kon: string; valueEncrypted: string }, access: { purpose: string }) => {
        if (sealed.kon !== konId) throw new Error("sealed for another kon");
        opened.push(access.purpose);
        return Buffer.from(sealed.valueEncrypted, "base64").toString();
      },
    },
    storage: {
      put: async (key: string, data: Buffer) => {
        files.set(key, Buffer.from(data));
        return { key, url: `https://files.test/${key}`, bytes: data.length };
      },
      get: async (key: string) => files.get(key) ?? null,
      delete: async (key: string) => void files.delete(key),
      list: async (prefix: string) => [...files.keys()].filter((k) => k.startsWith(prefix)),
      publicUrl: (key: string) => `https://files.test/${key}`,
      getSignedDownloadUrl: async (key: string) => `https://files.test/${key}?signed=1`,
      getSignedUploadUrl: async (key: string) => `https://files.test/${key}?upload=1`,
    },
    logger: {
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
      debug: () => {},
    },
    config: { siteName: "Test", siteUrl: "https://shop.test", environment: "test" },
  } as never);

  const odoo = new FakeOdoo();
  setOdooClientForTests(async () => odoo);

  const purges: Array<{ url: string; body: string; signature: string | null }> = [];
  let purgeStatus = 200;
  setPurgeNetworkForTests(async (url, init) => {
    purges.push({
      url,
      body: String(init.body),
      signature: new Headers(init.headers).get("x-inti-signature"),
    });
    return new Response("{}", { status: purgeStatus });
  });

  registerOdooPolicy();
  const app = host.mount(createOdooRouter(ctx));
  // The real API turns an AppError into its status; here, the same.
  app.onError((err) =>
    err instanceof AppError
      ? Response.json({ error: err.message }, { status: err.status })
      : Response.json({ error: String(err) }, { status: 500 })
  );
  const request = requestAs(app);
  registerOdooQueues(ctx);

  /** Runs every queued job through the kon's real handlers, until none is left. */
  async function drain(max = 300): Promise<Array<{ queue: string; name: string }>> {
    const ran: Array<{ queue: string; name: string }> = [];
    for (let i = 0; i < max && jobs.length; i++) {
      const j = jobs.shift()!;
      const handler = queueHandlers().get(j.queue);
      if (!handler) continue;
      const job: QueueJob = {
        id: `job-${i}`,
        queue: j.queue,
        name: j.name,
        payload: j.payload,
        attempt: 1,
        maxAttempts: 1,
        actor: null,
        requestId: null,
      };
      await handler.fn(job);
      ran.push({ queue: j.queue, name: j.name });
    }
    return ran;
  }

  /** Raw rows as the superuser that migrated, to look past row security. */
  async function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    await client.exec("RESET ROLE");
    try {
      return (await client.query<T>(sql, params)).rows;
    } finally {
      await client.exec(`SET ROLE ${APP_ROLE}`);
    }
  }

  /** POSTs a change notice the way Odoo would, signed. */
  function notice(body: unknown, secret = WEBHOOK_SECRET) {
    const raw = JSON.stringify(body);
    return request("anon", "POST", "/webhook", raw, {
      [SIGNATURE_HEADER]: signBody(raw, secret),
      "content-type": "application/json",
    });
  }

  let noticeCount = 0;
  /** Tells the kon these records changed and runs everything that follows. */
  async function changed(model: string, ...ids: number[]) {
    const response = await notice({ id: `n-${++noticeCount}`, changes: [{ model, ids }] });
    if (response.status !== 200) throw new Error(`notice refused: ${response.status} ${await response.text()}`);
    return drain();
  }

  async function close() {
    setOdooClientForTests(null);
    setPurgeNetworkForTests(null);
    await client.close();
  }

  return {
    client,
    ctx,
    odoo,
    request,
    jobs,
    events,
    files,
    opened,
    logs,
    purges,
    setPurgeStatus: (status: number) => {
      purgeStatus = status;
    },
    drain,
    rows,
    notice,
    changed,
    close,
  };
}

export type OdooBench = Awaited<ReturnType<typeof odooBench>>;
