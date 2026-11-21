/**
 * kon-odoo against a REAL Odoo (19 or later) with the kitsuden_bridge module, through JSON-2
 * ============================================================================
 *
 * Skipped unless pointed at one:
 *
 *   ODOO_LIVE_URL=http://127.0.0.1:8069 ODOO_LIVE_DB=live_kitsuden ODOO_LIVE_KEY_FILE=<file with the key> \
 *     pnpm vitest run tests/unit/kon-odoo-live.test.ts
 *
 * The Odoo is the one kitsuden-odoo-bridge's docker-compose.yml starts, seeded by its
 * scripts/seed_live.py (a shirt in red and blue with stock, a service, a customer with an
 * eWallet of 50, and the integration user whose key is in the file). Each run makes new orders
 * there; the catalog checks read what the seed made.
 *
 * kon-odoo runs on PGlite as in its other tests; only `FakeOdoo` is replaced by the real client.
 */

import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyOrderPayment } from "../../kons/kon-odoo/odoo.checkout";
import { createOdooClient, type OdooClient } from "../../kons/kon-odoo/odoo.client";
import { setOdooClientForTests } from "../../kons/kon-odoo/odoo.connection";
import { announcePayments } from "../../kons/kon-odoo/odoo.orders";

import { odooBench, WEBHOOK_SECRET, type OdooBench } from "./helpers/odoo-bench";

const url = process.env.ODOO_LIVE_URL;
const database = process.env.ODOO_LIVE_DB;
const keyFile = process.env.ODOO_LIVE_KEY_FILE;
const live = Boolean(url && database && keyFile);

let bench: OdooBench;
let odoo: OdooClient;
const run = Date.now().toString(36);

/**
 * The core's test setup replaces `fetch` with a mock so no test reaches the network. This one
 * must, so it speaks HTTP itself.
 */
function transport(target: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(target);
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const body = init.body ? Buffer.from(String(init.body), "utf8") : null;
    // A length, not chunks: Odoo reads a chunked body as empty, and an empty search_read
    // reads every field of every record.
    const headers = { ...(init.headers as Record<string, string>), ...(body ? { "content-length": String(body.length) } : {}) };
    const request = send(
      parsed,
      { method: init.method ?? "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 0 }))
        );
      }
    );
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("timeout")));
    if (body) request.write(body);
    request.end();
  });
}

const json = async (response: Response) => JSON.parse(await response.text());
const named = (name: string) => bench.events.filter((event) => event.name === name);
const asSystem = <T>(fn: () => Promise<T>) => (bench.ctx.db.asSystem ?? ((f: () => Promise<T>) => f()))(fn);

describe.skipIf(!live)("kon-odoo against a real Odoo", () => {
  beforeAll(async () => {
    bench = await odooBench();
    odoo = createOdooClient({
      baseUrl: url as string,
      database,
      apiKey: readFileSync(keyFile as string, "utf8").trim(),
      transport,
    });
    setOdooClientForTests(async () => odoo);
    await bench.request("staff", "PATCH", "/settings", { webhookSecret: WEBHOOK_SECRET });
  }, 120_000);

  afterAll(async () => {
    await bench?.close();
  });

  it("finds what this Odoo has installed, the bridge included", async () => {
    const response = await bench.request("staff", "POST", "/connection/check");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.capabilities).toMatchObject({
      stock: true,
      website: true,
      variants: true,
      loyalty: true,
      payments: true,
      bridge: true,
    });
    expect(body.currency).toMatch(/^[A-Z]{3}$/);
  });

  it("reads the whole catalog into the mirror", async () => {
    await bench.request("staff", "POST", "/sync");
    await bench.drain();
    const status = await json(await bench.request("staff", "GET", "/status"));
    expect(status.lastRun).toMatchObject({ status: "done" });

    const shop = await json(await bench.request("anon", "GET", "/catalog/products?search=Live"));
    const shirt = shop.docs.find((doc: { sku: string | null; title: string }) => doc.title === "Camiseta Live");
    expect(shirt).toBeDefined();
    expect(shirt.attributes).toEqual({ Color: expect.arrayContaining(["Red", "Blue"]) });
    expect(shirt.category?.title).toBe("Clothing");

    const product = await json(await bench.request("anon", "GET", `/catalog/products/${shirt.slug}`));
    const bySku = Object.fromEntries(product.variants.map((v: { sku: string; quantity: string | null }) => [v.sku, v]));
    expect(Number(bySku["LIVE-TEE-RED"].quantity)).toBeGreaterThan(0);
    expect(bySku["LIVE-TEE-RED"].options).toEqual({ Color: "Red" });

    // A service is not counted by Odoo: always for sale, no quantity.
    const wrap = shop.docs.find((doc: { title: string }) => doc.title === "Envoltorio Live");
    expect(wrap).toMatchObject({ availability: "InStock", quantity: null });
  });

  it("sells: cart, held units, order made in Odoo by the bridge, paid, confirmed, invoiced", async () => {
    const cart = await json(await bench.request("staff", "POST", "/carts"));
    await bench.request("staff", "PUT", `/carts/${cart.id}/lines`, { sku: "LIVE-TEE-RED", quantity: 1 });
    const ordered = await bench.request("staff", "POST", `/carts/${cart.id}/checkout`, {
      clientRef: `live-${run}-1`,
      customer: { email: "live@example.com", name: "Cliente Live" },
    });
    expect(ordered.status).toBe(201);
    const { id } = await json(ordered);
    await bench.drain();

    let order = await json(await bench.request("staff", "GET", `/orders/${id}`));
    expect(order, String(order.error)).toMatchObject({ status: "created", amountDue: "20.0000" });
    expect(order.odooName).toMatch(/^S\d+/);

    bench.events.length = 0;
    const outcome = await asSystem(() =>
      applyOrderPayment(bench.ctx, bench.ctx.db.instance as never, {
        provider: "tilopay",
        event: {
          type: "payment.succeeded",
          provider: "tilopay",
          externalId: `tilopay:live-${run}-1`,
          paymentId: `live-${run}-1`,
          settled: true,
          money: { amount: 2000, currency: order.currency },
          metadata: { odooOrderId: id },
        },
      })
    );
    expect(outcome).toMatchObject({ status: "paid" });
    await bench.drain();

    order = await json(await bench.request("staff", "GET", `/orders/${id}`));
    expect(order.status).toBe("confirmed");
    expect(order.settledAt).not.toBeNull();
    expect(named("odoo:sale_order.confirmed")[0].data).toMatchObject({ orderId: id, amountTotal: "20.0000" });

    // The bridge recorded the payment in Odoo: read it back and announce it.
    const [record] = await odoo.searchRead<{ payment_id: [number, string] | false; invoice_id: [number, string] | false }>(
      "kitsuden.bridge.payment",
      { domain: [["reference", "=", `live-${run}-1`]], fields: ["payment_id", "invoice_id"] }
    );
    expect(record.invoice_id).not.toBe(false);
    expect(record.payment_id).not.toBe(false);
    bench.events.length = 0;
    await announcePayments(bench.ctx, odoo, [(record.payment_id as [number, string])[0]]);
    const [paid] = named("odoo:payment.received");
    expect(paid.data).toMatchObject({ amount: "20.0000", partner: { email: "live@example.com" } });
    expect(paid.data.orders).toEqual([{ odooId: order.odooId, name: order.odooName }]);
  });

  it("pays part with store credit, and the card loses exactly that", async () => {
    const [card] = await odoo.searchRead<{ id: number; points: number }>("loyalty.card", {
      domain: [["partner_id.email", "=", "live@example.com"], ["program_id.program_type", "=", "ewallet"]],
      fields: ["points"],
    });
    const before = card.points;

    const ordered = await bench.request("staff", "POST", "/orders", {
      clientRef: `live-${run}-2`,
      customer: { email: "live@example.com", name: "Cliente Live" },
      lines: [{ sku: "LIVE-WRAP", quantity: 4 }],
      walletAmount: 5,
    });
    expect(ordered.status).toBe(201);
    const { id } = await json(ordered);
    await bench.drain();
    let order = await json(await bench.request("staff", "GET", `/orders/${id}`));
    expect(order).toMatchObject({ amountTotal: "12.0000", walletAmount: "5.0000", amountDue: "7.0000" });

    await asSystem(() =>
      applyOrderPayment(bench.ctx, bench.ctx.db.instance as never, {
        event: {
          type: "payment.succeeded",
          provider: "yappy",
          externalId: `yappy:live-${run}-2:E`,
          paymentId: `live-${run}-2`,
          settled: true,
          money: { amount: 700, currency: order.currency },
          metadata: { odooOrderId: id },
        },
      })
    );
    await bench.drain();

    order = await json(await bench.request("staff", "GET", `/orders/${id}`));
    expect(order).toMatchObject({ status: "confirmed", amountDue: "7.0000" });
    // In Odoo the order now carries the store credit as a line: its total is what the card paid.
    expect(order.amountTotal).toBe("7.0000");
    const [after] = await odoo.read<{ points: number }>("loyalty.card", [card.id], ["points"]);
    expect(after.points).toBeCloseTo(before - 5, 4);
  });

  it("a stock change made in Odoo reaches the shop when Odoo says so", async () => {
    const [red] = await odoo.searchRead<{ id: number; free_qty: number }>("product.product", {
      domain: [["default_code", "=", "LIVE-TEE-RED"]],
      fields: ["free_qty"],
    });
    await bench.changed("product.product", red.id);
    const product = await json(await bench.request("anon", "GET", "/catalog/products?search=Camiseta Live"));
    const slug = product.docs[0].slug;
    const detail = await json(await bench.request("anon", "GET", `/catalog/products/${slug}`));
    const variant = detail.variants.find((v: { sku: string }) => v.sku === "LIVE-TEE-RED");
    expect(Number(variant.quantity)).toBe(red.free_qty);
  });
});
