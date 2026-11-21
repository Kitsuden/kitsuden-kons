/**
 * kon-odoo — carts, stock held while a customer pays, the payment, and what happens when nobody pays
 * ============================================================================
 *
 * Real routes and queue handlers against the in-memory Odoo (tests/unit/helpers/odoo-bench.ts).
 * kon-payments is not loaded: what it would announce on the event bus is handed to the kon's own
 * listener, the way the bus would.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyOrderPayment, expireUnpaid, listenToPayments } from "../../kons/kon-odoo/odoo.checkout";
import { odooSchedules } from "../../kons/kon-odoo/odoo.queues";

import { odooBench, seedShop, WEBHOOK_SECRET, type OdooBench } from "./helpers/odoo-bench";

let bench: OdooBench;

beforeAll(async () => {
  bench = await odooBench();
  seedShop(bench.odoo);
  await bench.request("staff", "PATCH", "/settings", { webhookSecret: WEBHOOK_SECRET, holdMinutes: 10 });
  await bench.request("staff", "POST", "/connection/check");
  await bench.changed("product.template", 10, 11, 12);
}, 120_000);

afterAll(async () => {
  await bench?.close();
});

const json = async (response: Response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
const named = (name: string) => bench.events.filter((event) => event.name === name);
const customer = { email: "ana@example.com", name: "Ana Pérez" };

/** What kon-payments would announce for a settled payment. */
function paid(orderId: string, cents: number, extra: Record<string, unknown> = {}) {
  return {
    provider: "tilopay",
    event: {
      type: "payment.succeeded",
      provider: "tilopay",
      externalId: `tilopay:${orderId}:${cents}`,
      paymentId: `pay-${orderId.slice(0, 8)}-${cents}`,
      settled: true,
      money: { amount: cents, currency: "USD" },
      metadata: { odooOrderId: orderId },
      ...extra,
    },
  };
}

/** The ledger of the system, as the listener runs it. */
const asSystem = <T>(fn: () => Promise<T>) => (bench.ctx.db.asSystem ?? ((f: () => Promise<T>) => f()))(fn);
const pay = (payload: unknown) =>
  asSystem(() => applyOrderPayment(bench.ctx, bench.ctx.db.instance as never, payload));

const variantRow = async (sku: string) =>
  (await bench.rows<{ id: string; qty_free: string; qty_held: string }>(
    "SELECT id, qty_free::text, qty_held::text FROM odoo_variants WHERE sku = $1",
    [sku]
  ))[0];

describe("carts", () => {
  let cartId: string;

  it("only the shop's backend or the team opens one", async () => {
    expect((await bench.request("anon", "POST", "/carts")).status).toBe(401);
    expect((await bench.request("a", "POST", "/carts")).status).toBe(403);
    const response = await bench.request({ agent: ["odoo:*"] }, "POST", "/carts");
    expect(response.status).toBe(201);
    cartId = (await json(response)).id;
  });

  it("adds lines by id or reference and shows what is available", async () => {
    const red = await variantRow("TEE-RED");
    await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { variantId: red.id, quantity: 2 });
    const response = await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { sku: "WRAP", quantity: 1 });
    expect(response.status).toBe(200);
    const cart = await json(response);
    expect(cart.lines.map((line: { sku: string; quantity: string; available: string | null }) => [line.sku, line.quantity, line.available])).toEqual([
      ["TEE-RED", "2.0000", "4.0000"],
      ["WRAP", "1.0000", null],
    ]);
    expect(cart.estimatedTotal).toBe("42.9800");
    expect(cart.orderable).toBe(true);
  });

  it("says when a line asks for more than there is", async () => {
    await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { sku: "TEE-RED", quantity: 9 });
    const cart = await json(await bench.request("staff", "GET", `/carts/${cartId}`));
    expect(cart.orderable).toBe(false);
    expect(cart.lines[0].orderable).toBe(false);
    await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { sku: "TEE-RED", quantity: 2 });
  });

  it("refuses what is not for sale, and removes a line with zero", async () => {
    expect((await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { sku: "HOOD", quantity: 1 })).status).toBe(422);
    const cart = await json(await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { sku: "WRAP", quantity: 0 }));
    expect(cart.lines.map((line: { sku: string }) => line.sku)).toEqual(["TEE-RED"]);
    expect((await bench.request("staff", "GET", "/carts/not-a-uuid")).status).toBe(404);
  });

  it("checks out into an order that holds its units, and closes", async () => {
    const response = await bench.request("staff", "POST", `/carts/${cartId}/checkout`, { clientRef: "cart-0001", customer });
    expect(response.status).toBe(201);
    const order = await json(response);
    expect(order).toMatchObject({ status: "pending", walletAmount: "0.0000", amountDue: null, paidAt: null });
    expect(order.holdExpiresAt).not.toBeNull();

    expect(await variantRow("TEE-RED")).toMatchObject({ qty_free: "4.0000", qty_held: "2.0000" });
    const product = await json(await bench.request("anon", "GET", "/catalog/products/camiseta-basica-10"));
    expect(product.variants.find((v: { sku: string }) => v.sku === "TEE-RED").quantity).toBe("2.0000");

    // The same reference again is the same order; any change to the cart now is refused.
    const again = await bench.request("staff", "POST", `/carts/${cartId}/checkout`, { clientRef: "cart-0001", customer });
    expect(again.status).toBe(200);
    expect((await json(again)).id).toBe(order.id);
    expect((await bench.request("staff", "PUT", `/carts/${cartId}/lines`, { sku: "TEE-RED", quantity: 1 })).status).toBe(409);
    await bench.drain();
  });
});

describe("two customers, the last units", () => {
  it("the second checkout cannot take units the first one holds", async () => {
    // 4 free in Odoo, 2 held by cart-0001: 2 left.
    const first = await bench.request("staff", "POST", "/orders", {
      clientRef: "race-a",
      customer,
      lines: [{ sku: "TEE-RED", quantity: 2 }],
    });
    expect(first.status).toBe(201);
    const second = await bench.request("staff", "POST", "/orders", {
      clientRef: "race-b",
      customer: { email: "bo@example.com", name: "Bo" },
      lines: [{ sku: "TEE-RED", quantity: 1 }],
    });
    expect(second.status).toBe(409);
    expect(JSON.stringify(await json(second))).toContain("Not enough");
    // Refused whole: no order row was left behind.
    expect(await bench.rows("SELECT 1 FROM odoo_orders WHERE client_ref = 'race-b'")).toHaveLength(0);

    const shop = await json(await bench.request("anon", "GET", "/catalog/products?inStock=true"));
    // The shirt's blue variant has nothing free and the red one is all held: out of stock.
    expect(shop.docs.map((doc: { id: string }) => doc.id)).toEqual(["11"]);
    await bench.drain();
  });

  it("a sync that moves Odoo's free quantity keeps the holds", async () => {
    bench.odoo.find("product.product", 100)!.free_qty = 6;
    await bench.changed("product.product", 100);
    expect(await variantRow("TEE-RED")).toMatchObject({ qty_free: "6.0000", qty_held: "4.0000" });
    const product = await json(await bench.request("anon", "GET", "/catalog/products/camiseta-basica-10"));
    expect(product.variants.find((v: { sku: string }) => v.sku === "TEE-RED").quantity).toBe("2.0000");
    expect(product.availability).toBe("InStock");
  });
});

describe("paying an order", () => {
  let orderId: string;
  let odooId: number;

  beforeAll(async () => {
    const order = (await bench.rows<{ id: string; odoo_id: number; amount_due: string }>(
      "SELECT id, odoo_id, amount_due::text FROM odoo_orders WHERE client_ref = 'cart-0001'"
    ))[0];
    orderId = order.id;
    odooId = order.odoo_id;
  });

  it("knows what is due once Odoo has the order", async () => {
    const order = await json(await bench.request("staff", "GET", `/orders/${orderId}`));
    expect(order).toMatchObject({ status: "created", amountTotal: "39.9800", amountDue: "39.9800", currency: "USD" });
  });

  it("a payment for another amount settles nothing and is kept for a person", async () => {
    bench.events.length = 0;
    expect(await pay(paid(orderId, 100))).toMatchObject({ status: "refused" });
    expect(await pay(paid(orderId, 3998, { money: { amount: 3998, currency: "EUR" } }))).toMatchObject({ status: "refused" });
    expect(named("odoo:payment.mismatch")).toHaveLength(2);
    const conflicts = await json(await bench.request("staff", "GET", "/conflicts"));
    expect(conflicts.docs.some((c: { kind: string }) => c.kind === "payment_mismatch")).toBe(true);
    expect((await json(await bench.request("staff", "GET", `/orders/${orderId}`))).paidAt).toBeNull();
  });

  it("money that is not in yet, or a payment for something else, is ignored", async () => {
    expect(await pay(paid(orderId, 3998, { settled: false }))).toMatchObject({ status: "skipped" });
    expect(await pay({ event: { settled: true, metadata: { shopOrderId: "x" } } })).toMatchObject({ status: "skipped" });
    expect(await pay(null)).toMatchObject({ status: "skipped" });
  });

  it("the right payment marks it paid and Odoo is asked to confirm it", async () => {
    bench.events.length = 0;
    expect(await pay(paid(orderId, 3998))).toEqual({ status: "paid", orderId });
    expect(named("odoo:order.paid")[0].data).toMatchObject({ orderId, amount: "39.9800", currency: "USD" });
    // Paid twice: the same order is not paid again.
    expect(await pay(paid(orderId, 3998, { externalId: "other" }))).toEqual({ status: "exists", orderId });

    await bench.drain();
    expect(bench.odoo.calls.some((c) => c.model === "sale.order" && c.method === "action_confirm")).toBe(true);
    const order = await json(await bench.request("staff", "GET", `/orders/${orderId}`));
    expect(order).toMatchObject({ status: "confirmed", paidAmount: "39.9800", paymentProvider: "tilopay" });
    expect(order.settledAt).not.toBeNull();
    // Odoo counts its own reservation now: this kon's hold is gone.
    expect(await bench.rows("SELECT 1 FROM odoo_holds WHERE order_id = $1 AND released_at IS NULL", [orderId])).toHaveLength(0);
    expect(bench.odoo.find("sale.order", odooId)!.state).toBe("sale");
    expect(named("odoo:sale_order.confirmed").at(-1)!.data).toMatchObject({ orderId });
  });
});

describe("nobody paid", () => {
  let orderId: string;

  it("an order whose hold ran out expires, frees its units and is cancelled in Odoo", async () => {
    orderId = (await bench.rows<{ id: string }>("SELECT id FROM odoo_orders WHERE client_ref = 'race-a'"))[0].id;
    const before = await variantRow("TEE-RED");
    bench.events.length = 0;

    expect(await expireUnpaid(bench.ctx, new Date(Date.now() + 11 * 60_000))).toBe(1);
    const order = await json(await bench.request("staff", "GET", `/orders/${orderId}`));
    expect(order.status).toBe("expired");
    expect(Number((await variantRow("TEE-RED")).qty_held)).toBe(Number(before.qty_held) - 2);
    expect(named("odoo:order.expired")[0].data).toMatchObject({ orderId });

    await bench.drain();
    expect(bench.odoo.find("sale.order", order.odooId)!.state).toBe("cancel");
    // Odoo's "cancelled" does not turn the expired order back into anything else.
    await bench.changed("sale.order", order.odooId);
    expect((await json(await bench.request("staff", "GET", `/orders/${orderId}`))).status).toBe("cancelled");
  });

  it("the schedule that expires orders runs every minute", () => {
    expect(odooSchedules.find((s) => s.id === "expire-holds")?.cron).toBe("* * * * *");
  });

  it("a payment that arrives after the units were sold is kept for a person", async () => {
    // Somebody else takes everything that is left.
    const red = await variantRow("TEE-RED");
    const free = Number(red.qty_free) - Number(red.qty_held);
    expect(
      (await bench.request("staff", "POST", "/orders", { clientRef: "takes-all", customer, lines: [{ sku: "TEE-RED", quantity: free }] })).status
    ).toBe(201);
    await bench.drain();

    await bench.rows("UPDATE odoo_orders SET amount_due = 35, status = 'expired' WHERE id = $1", [orderId]);
    bench.events.length = 0;
    expect(await pay(paid(orderId, 3500))).toMatchObject({ status: "refused" });
    expect(named("odoo:order.paid_unavailable")).toHaveLength(1);
    const conflicts = await json(await bench.request("staff", "GET", "/conflicts"));
    expect(conflicts.docs.some((c: { kind: string }) => c.kind === "paid_unavailable")).toBe(true);
  });
});

describe("store credit", () => {
  it("is refused without the bridge module, before anything is held", async () => {
    bench.odoo.add("loyalty.card", {
      id: 50,
      partner_id: [bench.odoo.models["res.partner"].find((p) => p.email === "ana@example.com")!.id, "Ana"],
      "program_id.program_type": "ewallet",
      points: 20,
      expiration_date: false,
    });
    const response = await bench.request("staff", "POST", "/orders", {
      clientRef: "wallet-1",
      customer,
      lines: [{ sku: "WRAP", quantity: 1 }],
      walletAmount: 2,
    });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await json(response))).toContain("bridge module");
  });

  it("with the bridge: checked against Odoo, taken off what is due, and settled in one call", async () => {
    bench.odoo.installed["kitsuden.bridge"] = ["id"];
    await bench.request("staff", "POST", "/connection/check");

    expect(
      (await bench.request("staff", "POST", "/orders", { clientRef: "wallet-2", customer, lines: [{ sku: "WRAP", quantity: 1 }], walletAmount: 50 })).status
    ).toBe(409);

    // The bridge creates the order in one call; the double makes it the way `create` would.
    const create = bench.odoo.create.bind(bench.odoo);
    bench.odoo.call = (async (model: string, method: string, args: Record<string, unknown>, options?: { ids?: number[] }) => {
      if (model === "kitsuden.bridge" && method === "create_order") {
        const id = await create("sale.order", {
          partner_id: args.partner_id,
          client_order_ref: args.client_ref,
          order_line: (args.lines as Array<{ product_id: number; quantity: number }>).map((l) => [0, 0, { product_id: l.product_id, product_uom_qty: l.quantity }]),
        });
        return { id };
      }
      return Object.getPrototypeOf(bench.odoo).call.call(bench.odoo, model, method, args, options);
    }) as typeof bench.odoo.call;

    const response = await bench.request("staff", "POST", "/orders", {
      clientRef: "wallet-3",
      customer,
      lines: [{ sku: "WRAP", quantity: 2 }],
      walletAmount: 2.5,
    });
    expect(response.status).toBe(201);
    const { id } = await json(response);
    await bench.drain();

    const order = await json(await bench.request("staff", "GET", `/orders/${id}`));
    expect(order).toMatchObject({ amountTotal: "6.0000", walletAmount: "2.5000", amountDue: "3.5000" });

    expect(await pay(paid(id, 350))).toMatchObject({ status: "paid" });
    await bench.drain();
    expect(bench.odoo.bridgeCalls.at(-1)).toMatchObject({
      method: "confirm_payment",
      args: { order_id: order.odooId, client_ref: "wallet-3", amount: "3.5000", provider: "tilopay", wallet_amount: "2.5000" },
    });
    expect((await json(await bench.request("staff", "GET", `/orders/${id}`))).status).toBe("confirmed");
  });
});

describe("listening to kon-payments", () => {
  it("subscribes once, and an announcement it cannot record does not reach the payment", async () => {
    const handlers = new Map<string, Array<(payload: unknown) => void>>();
    const logs: string[] = [];
    const ctx = {
      events: { emit: () => {}, on: (name: string, fn: (payload: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), fn]) },
      db: {
        instance: {
          transaction: async () => {
            throw new Error("the database is away");
          },
        },
      },
      logger: { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), info: () => {}, debug: () => {} },
    };
    listenToPayments(ctx as never);
    listenToPayments(ctx as never);
    expect(handlers.get("payment:payment.succeeded")).toHaveLength(1);
    expect(() => handlers.get("payment:payment.succeeded")![0](paid("x", 1))).not.toThrow();
    await new Promise((done) => setTimeout(done, 20));
    expect(logs.join("\n")).toContain("could not be recorded");
  });
});
