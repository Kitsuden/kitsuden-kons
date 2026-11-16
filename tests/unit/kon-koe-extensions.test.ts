/**
 * kon-koe: the public extension API (koe.extensions.ts)
 * ============================================================================
 *
 * What the Enterprise edition, or anyone, relies on: a `beforeSend` refusal stops a message at send()
 * (409 POLICY) and at delivery (failed POLICY); a hook that throws refuses; `onAccess` hears reads and
 * changes; an `onAccess` that throws fails the request; removing an extension restores plain koe.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerKoeExtension, type AccessEvent } from "../../kons/kon-koe";

import { APP_SECRET, koeBench, waBody, waText } from "./helpers/koe-bench";
import { ACTORS } from "./helpers/safe-kons-bench";

describe("koe extensions", () => {
  let k: Awaited<ReturnType<typeof koeBench>>;
  let conv: string;
  const json = async (res: Response): Promise<any> => res.json();

  beforeAll(async () => {
    k = await koeBench();
    await k.request("admin", "PUT", `/members/${ACTORS.a.id}`, { role: "agent", displayName: "Ana" });
    await k.request("admin", "POST", "/channels", { kind: "whatsapp", name: "WA", externalId: "PN9", accountId: "w9", accessToken: "EAAG-token-xyz", appSecret: APP_SECRET });
    await k.webhook(waBody("PN9", { messages: [waText("51977", "wamid.x1", "hola")] }));
    await k.drain();
    conv = (await k.rows<any>("SELECT id FROM koe_conversations"))[0].id;
  });

  afterAll(async () => {
    await k?.close();
  });

  it("beforeSend refuses at send() with POLICY, and nothing is stored", async () => {
    const off = registerKoeExtension({ name: "no-weekends", beforeSend: (c) => (c.message.body?.includes("promo") ? "No promos today" : null) });
    try {
      const res = await k.request("a", "POST", `/conversations/${conv}/messages`, { body: "promo!" });
      expect(res.status).toBe(409);
      expect(JSON.stringify(await json(res))).toMatch(/POLICY|No promos today/);
      expect(await k.rows("SELECT 1 FROM koe_messages WHERE body = 'promo!'")).toEqual([]);
      expect((await k.request("a", "POST", `/conversations/${conv}/messages`, { body: "hola" })).status).toBe(201);
    } finally {
      off();
    }
  });

  it("beforeSend is asked again at delivery, and a throwing hook refuses", async () => {
    expect((await k.request("a", "POST", `/conversations/${conv}/messages`, { body: "later" })).status).toBe(201);
    const off = registerKoeExtension({
      name: "broken",
      beforeSend: (c) => {
        if (c.stage === "deliver") throw new Error("rules unavailable");
        return null;
      },
    });
    try {
      await k.drain();
      expect((await k.rows<any>("SELECT status, error_code FROM koe_messages WHERE body = 'later'"))[0]).toEqual({ status: "failed", error_code: "POLICY" });
    } finally {
      off();
    }
  });

  it("onAccess hears reads and changes; a failing one fails the request", async () => {
    const seen: AccessEvent["kind"][] = [];
    const off = registerKoeExtension({ name: "audit", onAccess: (e) => void seen.push(e.kind) });
    await k.request("a", "GET", `/conversations/${conv}`);
    await k.request("a", "GET", `/conversations/${conv}/messages`);
    await k.request("a", "POST", `/conversations/${conv}/notes`, { body: "note" });
    off();
    expect(seen).toEqual(expect.arrayContaining(["view", "messages", "note"]));

    const offFail = registerKoeExtension({ name: "audit-down", onAccess: () => Promise.reject(new Error("audit sink down")) });
    try {
      expect((await k.request("a", "GET", `/conversations/${conv}`)).status).toBe(500);
    } finally {
      offFail();
    }
    expect((await k.request("a", "GET", `/conversations/${conv}`)).status).toBe(200);
  });
});
