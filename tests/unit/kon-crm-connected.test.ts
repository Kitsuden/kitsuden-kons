/**
 * The CRM hears the shop, the newsletter, the payments and the mailbox
 * ============================================================================
 *
 * kon-crm's migrations and the core's `kitsuden_links` on PGlite, as the NON-superuser app role with no user
 * in the context: what a listener runs as (`asSystem`). The other kons are not here on purpose. They meet
 * the CRM only through events, so their events are written here exactly as each kon emits them; the
 * tests on the emitting side (shop-checkout-delivery, newsletter, payments) check the same shapes.
 *
 * What these tests hold:
 *   - a paid order finds its buyer through the duplicate detector, or creates them, and links the order;
 *   - an address on the exclusion list never becomes a contact, but an existing contact is still linked;
 *   - a payment with no email reaches the buyer through the order;
 *   - mail never creates contacts, and the mailbox's own address is not "about" anyone;
 *   - the timeline puts activities, stage moves and links in one list, newest first, and hides amounts
 *     from whoever may not see money;
 *   - with none of the other kons installed, the CRM starts, listens and nothing happens.
 */

import type { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { withoutMoney } from "../../kons/kon-crm/crm.access";
import {
  LINK_TYPE,
  contactOfOrder,
  listenToOtherKons,
  onInboxEvent,
  onInboxMessage,
  onNewsletterSubscribed,
  onPayment,
  onShopOrderPaid,
  splitName,
} from "../../kons/kon-crm/crm.connected";
import { aliasesOf, useCrmEvents } from "../../kons/kon-crm/crm.events";
import { timelineOf } from "../../kons/kon-crm/crm.timeline";

import { APP_ROLE, dropToAppRole, migratedBase } from "./helpers/safe-kons-bench";

const LINKS_SQL = resolve(__dirname, "../../.kitsuden/apps/api/src/db/migrations/0032_links.sql");

let client: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a drizzle over PGlite
let db: any;
const emitted: Array<{ name: string; data: unknown }> = [];
const bus = {
  emit: (name: string, data: unknown) => emitted.push({ name, data }),
  on: () => undefined,
  off: () => undefined,
};

async function q<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return (await client.query<T>(sql)).rows;
}

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(readFileSync(LINKS_SQL, "utf8"));
  await client.exec(`GRANT SELECT, INSERT, UPDATE, DELETE ON kitsuden_links TO ${APP_ROLE};`);
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('p1', 'Sales');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('s1', 'p1', 'Lead', 0), ('s2', 'p1', 'Proposal', 1);
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES
      ('c-ana', 'Ana', 'Ortega', 'Ana.Ortega@Client.example'),
      ('c-luis', 'Luis', 'Paz', 'luis@client.example');
    INSERT INTO crm_suppressions (kind, value) VALUES ('email', 'nobody@blocked.example');
  `);
  db = await dropToAppRole(client);
  useCrmEvents(bus as never);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  emitted.length = 0;
});

const paidOrder = (over: Record<string, unknown> = {}) => ({
  orderId: `o-${Math.random().toString(36).slice(2, 8)}`,
  number: "A-1001",
  customerEmail: "new.buyer@shop.example",
  customerName: "María José Ruiz",
  totalCents: 4500,
  currency: "EUR",
  ...over,
});

describe("splitName", () => {
  it("keeps the last word as the last name", () => {
    expect(splitName("María José Ruiz")).toEqual({ firstName: "María José", lastName: "Ruiz" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
    expect(splitName(null)).toEqual({ firstName: "", lastName: "" });
  });
});

describe("shop:order.paid", () => {
  it("creates the buyer as a contact and links the order to them", async () => {
    const order = paidOrder();
    const r = await onShopOrderPaid(db, order);
    expect(r).toMatchObject({ outcome: "linked", created: true });

    const [contact] = await q<{ first_name: string; last_name: string; origin: string; source: string; email: string }>(
      `SELECT first_name, last_name, origin, source, email FROM crm_contacts WHERE id = '${r.contactId}'`
    );
    expect(contact).toMatchObject({ first_name: "María José", last_name: "Ruiz", origin: "automation", source: "shop", email: "new.buyer@shop.example" });

    const links = await q<{ relation: string; metadata: Record<string, unknown> }>(
      `SELECT relation, metadata FROM kitsuden_links WHERE from_type = 'shop_orders' AND from_id = '${order.orderId}'`
    );
    expect(links).toHaveLength(1);
    expect(links[0]!.relation).toBe("ordered_by");
    expect(links[0]!.metadata).toMatchObject({ number: "A-1001", amountValue: 4500, currency: "EUR" });

    // The new contact announces itself under both names.
    expect(emitted.map((e) => e.name)).toEqual(["crm:contact:created", "crm:contact.created"]);
  });

  it("finds an existing contact by email through the duplicate detector, whatever the case", async () => {
    const r = await onShopOrderPaid(db, paidOrder({ customerEmail: "ANA.ORTEGA@client.example", customerName: "Ana Ortega" }));
    expect(r).toMatchObject({ outcome: "linked", contactId: "c-ana", created: false });
    expect(emitted).toEqual([]);
  });

  it("the same event twice makes one link and one contact", async () => {
    const order = paidOrder({ customerEmail: "twice@shop.example" });
    const a = await onShopOrderPaid(db, order);
    const b = await onShopOrderPaid(db, order);
    expect(b.contactId).toBe(a.contactId);
    const [{ n }] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM kitsuden_links WHERE from_id = '${order.orderId}'`);
    expect(n).toBe(1);
    const [{ m }] = await q<{ m: number }>(`SELECT count(*)::int AS m FROM crm_contacts WHERE lower(email) = 'twice@shop.example'`);
    expect(m).toBe(1);
  });

  it("an address on the exclusion list never becomes a contact", async () => {
    const r = await onShopOrderPaid(db, paidOrder({ customerEmail: "nobody@blocked.example" }));
    expect(r).toMatchObject({ outcome: "skipped", reason: "suppressed" });
    const rows = await q(`SELECT 1 FROM crm_contacts WHERE email = 'nobody@blocked.example'`);
    expect(rows).toHaveLength(0);
  });

  it("an event without an order or an email links nothing", async () => {
    expect(await onShopOrderPaid(db, { customerEmail: "x@y.example" })).toMatchObject({ outcome: "ignored" });
    expect(await onShopOrderPaid(db, paidOrder({ customerEmail: null }))).toMatchObject({ outcome: "skipped", reason: "no-email" });
    expect(await onShopOrderPaid(db, null)).toMatchObject({ outcome: "ignored" });
  });
});

describe("newsletter:member.subscribed", () => {
  it("links the member and the contact as the same person", async () => {
    const r = await onNewsletterSubscribed(db, { memberId: "m-1", email: "luis@client.example", name: "Luis Paz" });
    expect(r).toMatchObject({ outcome: "linked", contactId: "c-luis", created: false });
    const [row] = await q<{ relation: string }>(`SELECT relation FROM kitsuden_links WHERE from_type = 'nl_members' AND from_id = 'm-1'`);
    expect(row!.relation).toBe("same_person");
  });
});

describe("payment:payment.succeeded / refunded", () => {
  it("links the payment to the payer found by the provider's email", async () => {
    const r = await onPayment(db, "succeeded", {
      paymentEventId: "pe-1",
      event: { provider: "stripe", customerEmail: "luis@client.example", money: { amount: 1200, currency: "USD" }, metadata: {} },
    });
    expect(r).toMatchObject({ outcome: "linked", contactId: "c-luis" });
    const [row] = await q<{ relation: string; metadata: Record<string, unknown> }>(
      `SELECT relation, metadata FROM kitsuden_links WHERE from_type = 'pay_events' AND from_id = 'pe-1'`
    );
    expect(row).toMatchObject({ relation: "paid_by", metadata: { kind: "payment", amountValue: 1200, provider: "stripe" } });
  });

  it("without an email, reaches the buyer through the shop order", async () => {
    const order = paidOrder({ customerEmail: "through.order@shop.example" });
    const linked = await onShopOrderPaid(db, order);
    const r = await onPayment(
      db,
      "refunded",
      { paymentEventId: "pe-2", event: { provider: "stripe", metadata: { shopOrderId: order.orderId }, money: { amount: 4500, currency: "EUR" } } },
      (id) => contactOfOrder(db, id)
    );
    expect(r).toMatchObject({ outcome: "linked", contactId: linked.contactId });
    const [row] = await q<{ metadata: Record<string, unknown> }>(`SELECT metadata FROM kitsuden_links WHERE from_id = 'pe-2'`);
    expect(row!.metadata).toMatchObject({ kind: "refund", shopOrderId: order.orderId });
  });

  it("an event from a kon-payments without `paymentEventId` is ignored, not guessed", async () => {
    expect(await onPayment(db, "succeeded", { event: { customerEmail: "luis@client.example" } })).toMatchObject({ outcome: "ignored" });
  });
});

describe("inbox:message.received / inbox:event.synced", () => {
  it("links a message to the contacts on it, never creates one, and skips the mailbox's own address", async () => {
    const results = await onInboxMessage(db, {
      messageId: "msg-1",
      from: "me@firm.example",
      to: ["luis@client.example", "stranger@nowhere.example"],
      cc: ["ana.ortega@client.example"],
      mailboxAddresses: ["me@firm.example"],
      subject: "Proposal",
      direction: "out",
      at: "2026-11-10T10:00:00.000Z",
    });
    expect(results.map((r) => r.outcome).sort()).toEqual(["linked", "linked", "skipped"]);
    const rows = await q<{ to_id: string }>(`SELECT to_id FROM kitsuden_links WHERE from_id = 'msg-1' ORDER BY to_id`);
    expect(rows.map((r) => r.to_id)).toEqual(["c-ana", "c-luis"]);
    expect(await q(`SELECT 1 FROM crm_contacts WHERE email = 'stranger@nowhere.example'`)).toHaveLength(0);
  });

  it("a meeting is about each attendee that is a contact; a cancelled one links nothing", async () => {
    await onInboxEvent(db, { eventId: "ev-1", title: "Kickoff", attendees: ["luis@client.example", "me@firm.example"], mailboxAddresses: ["me@firm.example"] });
    expect(await q(`SELECT 1 FROM kitsuden_links WHERE from_id = 'ev-1'`)).toHaveLength(1);
    expect(await onInboxEvent(db, { eventId: "ev-2", cancelled: true, attendees: ["luis@client.example"] })).toEqual([
      { outcome: "ignored", reason: "cancelled" },
    ]);
  });
});

describe("view-timeline", () => {
  beforeAll(async () => {
    await client.exec(`
      RESET ROLE;
      INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id) VALUES ('d-luis', 'Luis renewal', 'p1', 's2', 'c-luis');
      INSERT INTO crm_stage_transitions (id, deal_id, from_stage_id, to_stage_id, entered_at, moved_by, move_reason)
        VALUES ('t1', 'd-luis', 's1', 's2', '2026-11-11T09:00:00Z', 'u-1', 'Sent the proposal');
      INSERT INTO crm_activities (id, type, subject, description, contact_id, created_at)
        VALUES ('a1', 'call', 'Intro call', 'Wants a discount', 'c-luis', '2026-11-09T09:00:00Z');
      SET ROLE ${APP_ROLE};
    `);
  });

  it("puts activities, stage moves and links in one list, newest first", async () => {
    const items = await timelineOf(db, { contactId: "c-luis" });
    const kinds = items.map((i) => (i.kind === "link" ? `link:${i.type}` : i.kind));
    expect(kinds).toEqual(expect.arrayContaining(["activity", "stage", "link:pay_events", "link:nl_members", "link:inbox_messages", "link:inbox_events"]));
    const ats = items.map((i) => i.at);
    expect([...ats].sort().reverse()).toEqual(ats);

    const stage = items.find((i) => i.kind === "stage");
    expect(stage).toMatchObject({ dealTitle: "Luis renewal", fromStage: "Lead", toStage: "Proposal", moveReason: "Sent the proposal" });
  });

  it("a deal's timeline has the deal's moves, not the contact's other links", async () => {
    const items = await timelineOf(db, { dealId: "d-luis" });
    expect(items.map((i) => i.kind)).toEqual(["stage"]);
  });

  it("amounts in links go away for whoever may not see money", async () => {
    const items = await timelineOf(db, { contactId: "c-luis" });
    const payment = withoutMoney(items.find((i) => i.kind === "link" && i.type === LINK_TYPE.payment)) as { summary: Record<string, unknown> };
    expect(payment.summary.amountValue).toBeUndefined();
    expect(payment.summary.currency).toBe("USD");
  });

  it("an unknown contact is a 404, and no target is a 422", async () => {
    await expect(timelineOf(db, { contactId: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(timelineOf(db, {})).rejects.toMatchObject({ status: 422 });
  });
});

describe("the event names", () => {
  it("each old event also goes out under its new name", () => {
    expect(aliasesOf("deal:stage-changed", { dealId: "d", fromStageId: "a", toStageId: "b" })).toEqual([
      ["crm:deal.moved", { dealId: "d", fromStageId: "a", toStageId: "b" }],
    ]);
    expect(aliasesOf("deal:status-changed", { dealId: "d", status: "won" })).toEqual([["crm:deal.won", { dealId: "d" }]]);
    expect(aliasesOf("deal:status-changed", { dealId: "d", status: "lost", lostReason: "price" })).toEqual([
      ["crm:deal.lost", { dealId: "d", lostReason: "price" }],
    ]);
    expect(aliasesOf("deal:status-changed", { dealId: "d", status: "open" })).toEqual([]);
  });
});

describe("with and without the other kons", () => {
  function fakeCtx() {
    const handlers = new Map<string, Array<(d: unknown) => void>>();
    const jobs: Promise<unknown>[] = [];
    const ctx = {
      events: {
        on: (name: string, h: (d: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
        emit: () => undefined,
      },
      db: {
        instance: db,
        asSystem: <T>(f: () => Promise<T>) => f(),
        background: (f: () => Promise<unknown>) => jobs.push(f()),
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
    return { ctx, handlers, jobs };
  }

  it("listens once per bus, to the six events, even when started twice", () => {
    const { ctx, handlers } = fakeCtx();
    listenToOtherKons(ctx as never);
    listenToOtherKons(ctx as never);
    expect([...handlers.keys()].sort()).toEqual([
      "inbox:event.synced",
      "inbox:message.received",
      "newsletter:member.subscribed",
      "payment:payment.refunded",
      "payment:payment.succeeded",
      "shop:order.paid",
    ]);
    for (const list of handlers.values()) expect(list).toHaveLength(1);
  });

  it("with the shop installed: its event, on the bus, becomes a contact and a link", async () => {
    const { ctx, handlers, jobs } = fakeCtx();
    listenToOtherKons(ctx as never);
    const order = paidOrder({ customerEmail: "bus@shop.example" });
    handlers.get("shop:order.paid")![0]!(order);
    await Promise.all(jobs);
    expect(await q(`SELECT 1 FROM kitsuden_links WHERE from_id = '${order.orderId}'`)).toHaveLength(1);
  });

  it("a broken event is logged, never thrown at the kon that emitted it", async () => {
    const { ctx, handlers, jobs } = fakeCtx();
    const warned: string[] = [];
    ctx.logger.warn = ((m: string) => warned.push(m)) as never;
    ctx.db.instance = { transaction: () => Promise.reject(new Error("db down")) } as never;
    listenToOtherKons(ctx as never);
    expect(() => handlers.get("shop:order.paid")![0]!(paidOrder())).not.toThrow();
    await Promise.all(jobs);
    expect(warned).toEqual(["[CRM] could not record a paid order"]);
  });

  it("without them: a bus nobody emits on leaves the CRM as it was, and a bus without `on` is fine", async () => {
    const before = await q<{ n: number }>(`SELECT count(*)::int AS n FROM crm_contacts`);
    const { ctx } = fakeCtx();
    listenToOtherKons(ctx as never);
    listenToOtherKons({ ...ctx, events: { emit: () => undefined } } as never);
    expect(await q<{ n: number }>(`SELECT count(*)::int AS n FROM crm_contacts`)).toEqual(before);
    // The timeline of a contact nothing was linked to still answers.
    expect((await timelineOf(db, { contactId: "c-ana" })).every((i) => i.kind !== "stage")).toBe(true);
  });
});
