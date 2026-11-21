/**
 * kon-odoo and kon-conta, together, with neither importing the other
 * ============================================================================
 *
 * Both kons' migrations on one PGlite, as a NON-superuser role. An order goes through kon-odoo's
 * real routes and queue into an Odoo that lives in memory; what kon-odoo ANNOUNCES is then handed
 * to kon-conta's listener functions, the way the event bus would. The ledger ends with the
 * customer, an issued invoice and its payment, and saying everything twice changes nothing.
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contaEvents, invoiceFromOdooOrder, listenToOtherKons, paymentFromOdoo } from "../../kons/kon-conta/conta.connected";
import { ContaService } from "../../kons/kon-conta/conta.service";
import { odooEvents } from "../../kons/kon-odoo/odoo.events";

import { odooBench, seedShop, WEBHOOK_SECRET, type OdooBench } from "./helpers/odoo-bench";
import { APP_ROLE } from "./helpers/safe-kons-bench";

let bench: OdooBench;

const contaMigrations = () => {
  const dir = resolve(__dirname, "../../kons/kon-conta/migrations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => readFileSync(resolve(dir, file), "utf8"));
};

/** The ledger's writes happen as the system: no user, no role, on the app's own database role. */
const ledger = () => bench.ctx.db.instance;
const last = (name: string) => bench.events.filter((event) => event.name === name).at(-1)!.data;

beforeAll(async () => {
  bench = await odooBench();
  seedShop(bench.odoo);

  await bench.client.exec("RESET ROLE");
  for (const sql of contaMigrations()) await bench.client.exec(sql);
  await bench.client.exec(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE};
  `);
  await new ContaService(drizzle(bench.client) as never).seedDefaultAccounts();
  await bench.client.exec(`SET ROLE ${APP_ROLE}`);

  await bench.request("staff", "PATCH", "/settings", { webhookSecret: WEBHOOK_SECRET });
  await bench.changed("product.template", 10, 11, 12);
}, 180_000);

afterAll(async () => {
  await bench?.close();
});

describe("kon-odoo → kon-conta", () => {
  it("each side declares what the other expects, by name", () => {
    for (const event of contaEvents.listens ?? []) expect(Object.keys(odooEvents.emits)).toContain(event);
  });

  it("a confirmed order becomes the customer and an issued invoice", async () => {
    const response = await bench.request("staff", "POST", "/orders", {
      clientRef: "web-conta-1",
      customer: { email: "ana@example.com", name: "Ana Pérez", vat: "8-123-456" },
      lines: [
        { sku: "TEE-RED", quantity: 2 },
        { sku: "WRAP", quantity: 1 },
      ],
    });
    expect(response.status).toBe(201);
    await bench.drain();

    const sale = bench.odoo.models["sale.order"][0];
    // Odoo taxes it: 7 % on 42.98.
    Object.assign(sale, { state: "sale", amount_tax: 3.01, amount_total: 45.99 });
    await bench.changed("sale.order", sale.id);

    const outcome = await invoiceFromOdooOrder(ledger(), last("odoo:sale_order.confirmed"));
    expect(outcome.status).toBe("recorded");

    const [invoice] = await bench.rows<Record<string, string>>(
      "SELECT i.*, c.name AS client_name, c.external_ref AS client_ref, c.tax_id FROM conta_invoices i JOIN conta_counterparties c ON c.id = i.client_id WHERE i.source = 'odoo'"
    );
    expect(invoice).toMatchObject({
      status: "issued",
      external_ref: `odoo-so:${sale.id}`,
      concept: `Odoo order ${sale.name}`,
      issue_date: "2026-11-20",
      currency: "USD",
      fees: "42.9800",
      tax: "3.0100",
      total: "45.9900",
      amount_paid: "0.0000",
      client_name: "Ana Pérez",
      tax_id: "8-123-456",
    });
    expect(invoice.client_ref).toMatch(/^odoo-partner:\d+$/);
    expect(invoice.number).toBeTruthy();

    // The invoice is in the books: a posted journal that balances.
    const [journal] = await bench.rows<{ status: string; debit: string; credit: string }>(
      `SELECT j.status, sum(e.debit)::text AS debit, sum(e.credit)::text AS credit
         FROM conta_journals j JOIN conta_ledger_entries e ON e.journal_id = j.id
        WHERE j.id = $1 GROUP BY j.status`,
      [invoice.journal_id]
    );
    expect(journal.status).toBe("posted");
    expect(Number(journal.debit)).toBeCloseTo(45.99, 4);
    expect(journal.debit).toBe(journal.credit);

    const lines = await bench.rows<{ description: string; quantity: string; unit_price: string }>(
      "SELECT description, quantity::text, unit_price::text FROM conta_invoice_lines WHERE invoice_id = $1 ORDER BY position",
      [invoice.id]
    );
    expect(lines).toHaveLength(2);
    expect(Number(lines[0].quantity)).toBe(2);
    expect(Number(lines[0].unit_price)).toBe(19.99);
  });

  it("the same order announced again is not billed twice", async () => {
    const outcome = await invoiceFromOdooOrder(ledger(), last("odoo:sale_order.confirmed"));
    expect(outcome.status).toBe("exists");
    expect(await bench.rows("SELECT 1 FROM conta_invoices WHERE source = 'odoo'")).toHaveLength(1);
    expect(await bench.rows("SELECT 1 FROM conta_counterparties WHERE external_ref LIKE 'odoo-partner:%'")).toHaveLength(1);
  });

  it("the database refuses a second invoice for one order, whatever the code does", async () => {
    await expect(
      bench.rows(
        `INSERT INTO conta_invoices (id, client_id, concept, revenue_account_id, currency, issue_date, due_date, terms_days, source, external_ref)
         SELECT 'dup', client_id, 'x', revenue_account_id, currency, issue_date, due_date, terms_days, source, external_ref
           FROM conta_invoices WHERE source = 'odoo'`
      )
    ).rejects.toThrow(/idx_conta_invoices_external_document|duplicate key/);
  });

  it("a payment in Odoo pays that invoice, once", async () => {
    const sale = bench.odoo.models["sale.order"][0];
    bench.odoo.add("account.move", { id: 700, invoice_origin: sale.name });
    bench.odoo.add("account.payment", {
      id: 800,
      amount: 45.99,
      currency_id: [1, "USD"],
      partner_id: sale.partner_id,
      date: "2026-11-22",
      state: "paid",
      payment_type: "inbound",
      memo: "Stripe pi_123",
      reconciled_invoice_ids: [700],
    });
    await bench.changed("account.payment", 800);
    const event = last("odoo:payment.received");

    expect((await paymentFromOdoo(ledger(), event)).status).toBe("recorded");
    expect((await paymentFromOdoo(ledger(), event)).status).toBe("exists");

    const [invoice] = await bench.rows<{ amount_paid: string; total: string }>(
      "SELECT amount_paid::text, total::text FROM conta_invoices WHERE source = 'odoo'"
    );
    expect(invoice.amount_paid).toBe(invoice.total);
    const payments = await bench.rows<{ reference: string; method: string; date: string; amount: string }>(
      "SELECT reference, method, date, amount::text FROM conta_invoice_payments"
    );
    expect(payments).toEqual([{ reference: "odoo-payment:800", method: "odoo", date: "2026-11-22", amount: "45.9900" }]);
  });

  it("leaves out what it would have to guess", async () => {
    const order = last("odoo:sale_order.confirmed");
    const invoices = async () => (await bench.rows("SELECT 1 FROM conta_invoices")).length;
    const before = await invoices();

    // Another currency: the ledger has no rate for it.
    const euros = await invoiceFromOdooOrder(ledger(), { ...order, odooId: 9001, currency: "EUR" });
    expect(euros).toMatchObject({ status: "skipped" });
    expect((euros as { reason: string }).reason).toContain("EUR");

    expect(await invoiceFromOdooOrder(ledger(), { ...order, odooId: 9002, partner: null })).toMatchObject({ status: "skipped" });
    expect(await invoiceFromOdooOrder(ledger(), { ...order, odooId: 9003, lines: [] })).toMatchObject({ status: "skipped" });
    expect(await invoiceFromOdooOrder(ledger(), { nonsense: true })).toMatchObject({ status: "skipped" });
    expect(await invoiceFromOdooOrder(ledger(), null)).toMatchObject({ status: "skipped" });

    expect(await paymentFromOdoo(ledger(), { paymentId: 901, amount: "10.0000", currency: "USD", orders: [] })).toMatchObject({ status: "skipped" });
    expect(
      await paymentFromOdoo(ledger(), { paymentId: 902, amount: "10.0000", currency: "USD", orders: [{ odooId: 424242 }] })
    ).toMatchObject({ status: "skipped" });
    // The invoice is paid in full: a second payment on it has nowhere to go.
    const sale = bench.odoo.models["sale.order"][0];
    expect(
      await paymentFromOdoo(ledger(), { paymentId: 903, amount: "5.0000", currency: "USD", orders: [{ odooId: sale.id }] })
    ).toMatchObject({ status: "skipped" });

    expect(await invoices()).toBe(before);
    expect(await bench.rows("SELECT 1 FROM conta_invoice_payments")).toHaveLength(1);
  });

  it("a discounted line goes in at what was sold, so the totals agree", async () => {
    const order = last("odoo:sale_order.confirmed");
    const outcome = await invoiceFromOdooOrder(ledger(), {
      ...order,
      odooId: 9100,
      name: "S09100",
      // 3 × 10.00 with 10 % off: Odoo's subtotal is 27.00.
      lines: [{ name: "Sleeves", quantity: "3.0000", unitPrice: "10.0000", subtotal: "27.0000", total: "27.0000" }],
      amountUntaxed: "27.0000",
      amountTax: "0.0000",
      amountTotal: "27.0000",
    });
    expect(outcome.status).toBe("recorded");
    const [invoice] = await bench.rows<{ total: string }>(
      "SELECT total::text FROM conta_invoices WHERE external_ref = 'odoo-so:9100'"
    );
    expect(invoice.total).toBe("27.0000");
  });

  it("a person who is not on the accounting team cannot do this through the listener's functions", async () => {
    const { sqlAs } = await import("./helpers/safe-kons-bench");
    await expect(
      sqlAs(bench.client, "a", "UPDATE conta_invoices SET total = 0 WHERE source = 'odoo' RETURNING id", [])
    ).resolves.toHaveLength(0);
  });
});

describe("the listener", () => {
  it("subscribes once, runs as the system, and a failure does not reach the emitter", async () => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const logs: string[] = [];
    let asSystem = 0;
    const ctx = {
      events: {
        emit: () => {},
        on: (name: string, fn: (payload: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
      },
      db: {
        instance: {
          transaction: async () => {
            throw new Error("the database is away");
          },
        },
        asSystem: async <T>(fn: () => Promise<T>) => {
          asSystem++;
          return fn();
        },
      },
      logger: {
        warn: (message: string) => logs.push(message),
        error: (message: string) => logs.push(message),
        info: () => {},
        debug: () => {},
      },
    };

    // Off by default: Odoo keeping its own books is the usual case.
    listenToOtherKons(ctx as never, {});
    expect(handlers.size).toBe(0);

    listenToOtherKons(ctx as never, { CONTA_FOLLOW_ODOO: "true" });
    listenToOtherKons(ctx as never, { CONTA_FOLLOW_ODOO: "true" });
    expect([...handlers.keys()].sort()).toEqual(["odoo:payment.received", "odoo:sale_order.confirmed"]);
    expect(handlers.get("odoo:sale_order.confirmed")).toHaveLength(1);

    expect(() => handlers.get("odoo:sale_order.confirmed")![0]({ odooId: 1 })).not.toThrow();
    await new Promise((done) => setTimeout(done, 20));
    expect(asSystem).toBe(1);
    expect(logs.join("\n")).toContain("could not be recorded");
  });
});
