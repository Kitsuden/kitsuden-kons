/**
 * Emails copied to the CRM: signed, from the team, vouched for, and only onto contacts that exist
 * ============================================================================
 *
 * Every kon-crm migration on PGlite as a NON-superuser role. The provider posts like Mailgun (form), Postmark
 * (JSON with a basic-auth secret) or a relay of your own (HMAC over timestamp and body). What these tests hold:
 * the three locks are closed by default, a retry records once, a forward is attributed to the client who wrote
 * it, no contact is ever created, and an admin sees why something was turned away.
 */

import type { PGlite } from "@electric-sql/pglite";
import { createHmac } from "node:crypto";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { rlsHost } from "../../.kitsuden/tests/unit/helpers/rls-host";
import { forwardedOriginal, parseAddresses } from "../../kons/kon-crm/crm.inbound";
import { registerCrmPolicy } from "../../kons/kon-crm/crm.policy";
import { createCRMRouter } from "../../kons/kon-crm/crm.routes";

import { dropToAppRole, migratedBase, requestAs, testAuth } from "./helpers/safe-kons-bench";

let client: PGlite;
let request: ReturnType<typeof requestAs>;
const json = (res: Response): Promise<any> => res.json();
const KEY = "mailgun-test-signing-key";
const POSTMARK = "postmark-test-token";
const SECRET = "relay-test-secret";
const ENV = {
  CRM_INBOUND_ALLOWED_SENDERS: "firm.example, partner@gmail.com",
  MAILGUN_WEBHOOK_SIGNING_KEY: KEY,
  CRM_INBOUND_POSTMARK_TOKEN: POSTMARK,
  CRM_INBOUND_SECRET: SECRET,
};
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  const dir = resolve(__dirname, "../../kons/kon-crm/migrations");
  client = await migratedBase("kon-crm", readdirSync(dir).filter((f) => f.endsWith(".sql")).sort());
  await client.exec(`
    INSERT INTO crm_pipelines (id, name) VALUES ('p1', 'P');
    INSERT INTO crm_pipeline_stages (id, pipeline_id, name, "order") VALUES ('s1', 'p1', 'A', 0);
    INSERT INTO crm_contacts (id, first_name, last_name, email) VALUES
      ('c1', 'Ana', 'Ortega', 'Ana@Client.example'),
      ('c2', 'Bruno', 'Paz', 'bruno@other.example');
    INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id) VALUES ('d1', 'Only deal', 'p1', 's1', 'c1');
    INSERT INTO crm_deals (id, title, pipeline_id, stage_id, contact_id) VALUES ('d2', 'One', 'p1', 's1', 'c2'), ('d3', 'Two', 'p1', 's1', 'c2');
  `);
  const db = await dropToAppRole(client);
  const auth = testAuth();
  const host = rlsHost(db, auth);
  const ctx = createTestKonContext({ db: host.db as never, auth: auth as never });
  request = requestAs(host.mount(createCRMRouter(ctx)));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerCrmPolicy();
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});

afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function mailgunForm(fields: Record<string, string>, opts: { timestamp?: number; key?: string } = {}): FormData {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const token = `tok-${Math.random().toString(36).slice(2)}`;
  const form = new FormData();
  const all: Record<string, string> = {
    timestamp,
    token,
    signature: createHmac("sha256", opts.key ?? KEY).update(timestamp + token).digest("hex"),
    recipient: "crm@firm.example",
    "X-Mailgun-Spf": "Pass",
    "X-Mailgun-Dkim-Check-Result": "Pass",
    Date: "Mon, 02 Nov 2026 10:00:00 -0500",
    ...fields,
  };
  for (const [k, v] of Object.entries(all)) form.append(k, v);
  return form;
}

const mailgun = (fields: Record<string, string>, opts?: { timestamp?: number; key?: string }) =>
  request("anon", "POST", "/public/inbound/mailgun", mailgunForm(fields, opts));

const activitiesOf = async (contactId: string) =>
  (await json(await request("admin", "GET", `/activities?contactId=${contactId}&type=email`))).data;

describe("the parsers", () => {
  it("reads address lists with names, quotes and commas", () => {
    expect(parseAddresses(`Ana Ortega <ana@x.com>, "Paz, Bruno" <BRUNO@y.com>, c@z.com`)).toEqual([
      { email: "ana@x.com", name: "Ana Ortega" },
      { email: "bruno@y.com", name: "Paz, Bruno" },
      { email: "c@z.com" },
    ]);
  });

  it("finds the client inside a forward, in English and Spanish", () => {
    const gmail = "FYI\n\n---------- Forwarded message ---------\nFrom: Ana Ortega <ana@client.example>\nDate: Mon\nSubject: Contract\nTo: me@firm.example\n\nPlease review.\n\nAna Ortega\nCFO, Client SA";
    expect(forwardedOriginal("Fwd: Contract", gmail)).toEqual({ from: { email: "ana@client.example", name: "Ana Ortega" }, text: "Please review.\n\nAna Ortega\nCFO, Client SA" });
    const outlook = "________________________________\nDe: Bruno Paz <bruno@other.example>\nEnviado: lunes\nPara: yo\nAsunto: Hola\n\nTexto";
    expect(forwardedOriginal("RV: Hola", outlook)?.from.email).toBe("bruno@other.example");
    expect(forwardedOriginal("Re: Contract", "Thanks, see you")).toBeNull();
  });
});

describe("Mailgun", () => {
  it("a Bcc'd email lands on the contact, linked to its only open deal", async () => {
    const res = await mailgun({
      "Message-Id": "<m1@firm.example>",
      from: "Lia Mar <lia@firm.example>",
      To: "Ana Ortega <ana@client.example>",
      subject: "Next steps",
      "body-plain": "Hi Ana, attached.\n\n> old quoted text",
      "stripped-text": "Hi Ana, attached.",
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, outcome: "recorded", unmatched: [] });
    const [a] = await activitiesOf("c1");
    expect(a).toMatchObject({ type: "email", subject: "Next steps", description: "Hi Ana, attached.", dealId: "d1", origin: "email" });
    expect(a.metadata).toMatchObject({ direction: "sent", from: "lia@firm.example", loggedBy: "lia@firm.example" });
  });

  it("a retry of the same message records once", async () => {
    const fields = { "Message-Id": "<m1@firm.example>", from: "lia@firm.example", To: "ana@client.example", subject: "Next steps" };
    expect(await json(await mailgun(fields))).toMatchObject({ outcome: "duplicate" });
    expect(await activitiesOf("c1")).toHaveLength(1);
  });

  it("a forward is the client's email, and a contact with several open deals is left for a person to link", async () => {
    const res = await json(
      await mailgun({
        "Message-Id": "<m2@firm.example>",
        from: "partner@gmail.com",
        To: "crm@firm.example",
        subject: "Fwd: Question",
        "body-plain": "---------- Forwarded message ---------\nFrom: Bruno Paz <bruno@other.example>\nSubject: Question\n\nCan we meet?\n\nBruno Paz | Director",
      })
    );
    expect(res.outcome).toBe("recorded");
    const [a] = await activitiesOf("c2");
    expect(a).toMatchObject({ dealId: null, description: "Can we meet?\n\nBruno Paz | Director" });
    expect(a.metadata).toMatchObject({ direction: "received", from: "bruno@other.example", loggedBy: "partner@gmail.com" });
  });

  it("refuses a bad signature, an old one, and an unconfigured provider", async () => {
    const fields = { "Message-Id": "<m3@x>", from: "lia@firm.example", To: "ana@client.example", subject: "x" };
    expect((await mailgun(fields, { key: "wrong" })).status).toBe(401);
    expect((await mailgun(fields, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    delete process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
    expect((await mailgun(fields)).status).toBe(404);
    expect((await request("anon", "POST", "/public/inbound/sendgrid", {})).status).toBe(404);
  });
});

describe("what is turned away, with its reason", () => {
  const send = (id: string, extra: Record<string, string>) =>
    mailgun({ "Message-Id": `<${id}@x>`, from: "lia@firm.example", To: "ana@client.example", subject: id, ...extra });

  it("nothing at all until senders are allowed", async () => {
    delete process.env.CRM_INBOUND_ALLOWED_SENDERS;
    expect(await json(await send("r1", {}))).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/CRM_INBOUND_ALLOWED_SENDERS/) });
  });

  it("a sender outside the team, or one whose domain did not vouch for it", async () => {
    expect(await json(await send("r2", { from: "spoof@evil.example" }))).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/not on the allowed senders/) });
    expect(await json(await send("r3", { "X-Mailgun-Spf": "Fail", "X-Mailgun-Dkim-Check-Result": "Fail" }))).toMatchObject({ outcome: "rejected", reason: expect.stringMatching(/SPF and DKIM/) });
  });

  it("never creates a contact: unknown addresses are listed for a person", async () => {
    const r = await json(await send("r4", { To: "stranger@new.example, colleague@firm.example" }));
    expect(r).toMatchObject({ outcome: "rejected", unmatched: ["stranger@new.example"] });
    const n = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM crm_contacts");
    expect(n.rows[0]!.n).toBe(2);
  });

  it("an admin sees each receipt and the setup, never the secrets; nobody else does", async () => {
    const list = await json(await request("admin", "GET", "/inbound-emails?status=rejected"));
    expect(list.data.map((r: { subject: string }) => r.subject)).toEqual(expect.arrayContaining(["r1", "r2", "r3", "r4"]));
    expect(list.setup).toEqual({ providers: ["mailgun", "postmark", "generic"], allowedSenders: 2, path: "/api/crm/public/inbound/<provider>" });
    expect(JSON.stringify(list)).not.toMatch(new RegExp(`${KEY}|${POSTMARK}|${SECRET}`));
    expect((await request("staff", "GET", "/inbound-emails")).status).toBe(403);
  });
});

describe("Postmark and a relay of your own", () => {
  it("Postmark needs its secret, and reads SPF from the headers", async () => {
    const body = {
      FromFull: { Email: "lia@firm.example", Name: "Lia" },
      ToFull: [{ Email: "ana@client.example" }],
      CcFull: [],
      OriginalRecipient: "crm@firm.example",
      Subject: "From Postmark",
      TextBody: "Hello",
      Date: "Tue, 03 Nov 2026 09:00:00 -0500",
      Headers: [
        { Name: "Message-ID", Value: "<pm1@firm.example>" },
        { Name: "Received-SPF", Value: "Pass (sender SPF authorized) identity=mailfrom" },
      ],
    };
    const basic = (pw: string) => ({ authorization: `Basic ${Buffer.from(`crm:${pw}`).toString("base64")}` });
    expect((await request("anon", "POST", "/public/inbound/postmark", body, basic("wrong"))).status).toBe(401);
    expect(await json(await request("anon", "POST", "/public/inbound/postmark", body, basic(POSTMARK)))).toMatchObject({ outcome: "recorded" });
  });

  it("a relay signs timestamp and body, and must say the sender was vouched for", async () => {
    const post = (payload: object, opts: { secret?: string; ts?: number } = {}) => {
      const raw = JSON.stringify(payload);
      const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
      const sig = createHmac("sha256", opts.secret ?? SECRET).update(`${ts}.${raw}`).digest("hex");
      return request("anon", "POST", "/public/inbound/generic", raw, { "x-kitsuden-timestamp": ts, "x-kitsuden-signature": `sha256=${sig}` });
    };
    const mail = { messageId: "<g1@firm.example>", from: { email: "lia@firm.example" }, to: [{ email: "bruno@other.example" }], subject: "Relay", text: "Hi", authenticated: true };
    expect((await post(mail, { secret: "wrong" })).status).toBe(401);
    expect(await json(await post({ ...mail, messageId: "<g0@x>", authenticated: false }))).toMatchObject({ outcome: "rejected" });
    expect(await json(await post(mail))).toMatchObject({ outcome: "recorded" });
    expect((await post({ nonsense: true })).status).toBe(400);
  });
});
