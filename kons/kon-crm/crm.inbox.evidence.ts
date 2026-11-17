/**
 * What an email says about who someone is
 * ============================================================================
 *
 * A message synced into the inbox (crm.inbox.ts) from an address that is a contact says two things about them
 * without anyone reading it: the name they write under (`"Ana Ruiz" <ana@acme.example>`) and, for a company
 * address, the company's domain. Both go through the CRM's evidence rules (crm.evidence.ts), as kind
 * `mail-header`, exactly like a fact an agent or a data provider reports:
 *
 *   contact.firstName / lastName   from the display name of a message they SENT (direction `in`)
 *   company.domain                 from their address, when the contact belongs to a company and the
 *                                  address is not at a free mail provider (gmail.com, outlook.com…)
 *
 * ── WHY ONLY A SUGGESTION ──────────────────────────────────────────────────
 *
 * Anyone types any display name, and many are not a name at all ("Billing", "ACME Support", "Ana from ACME").
 * So `mail-header` weighs 10 (migrations/0015_inbox.sql), far under the 70 a value needs to be written by
 * itself: it lands as a suggestion a person accepts or rejects, never over what a person typed. The same name
 * seen again adds nothing (every message is one source, `mail`), and a rejected one is never applied.
 *
 * ── WHAT IT NEVER CARRIES ──────────────────────────────────────────────────
 *
 * The subject, the preview, who else was on the message or which mailbox it came from. An observation is read
 * by the whole CRM team; the message may be its owner's private mail (row security on the inbox's tables).
 * What leaves the message is the sender's own display name and domain, which the contact shows to anyone they
 * write to, and the message's id in `externalRef`, so a retried sync records it once.
 *
 * Nothing is created: an address that is not exactly one contact is ignored, as the timeline ignores it.
 */

import { sql } from "drizzle-orm";

import type { CrmDb } from "./crm.db";
import { normalizeEmail } from "./crm.dedupe";
import { observe, type ObservationOutcome } from "./crm.evidence";
import { crmCompanies, crmContacts } from "./crm.schema";

export const MAIL_EVIDENCE = "mail-header";
/** All mail is one source: the same name in a hundred messages is one piece of evidence, not a hundred. */
const SOURCE = "mail";

/** Providers anyone can have an address at: their domain says nothing about a company. */
const FREE_MAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.es",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.es",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
  "mail.com",
]);

/** Words that make a display name a team, a role or a system rather than a person. */
const NOT_A_PERSON =
  /\b(team|support|sales|billing|info|admin|noreply|no-reply|do not reply|notifications?|newsletter|help|service|office|contact|marketing|accounts?|hr|jobs|careers|via|from|at)\b/i;

export interface ParsedName {
  firstName: string;
  lastName: string | null;
}

/**
 * A person's name from a display name, or `null` when it does not look like one. "Ruiz, Ana" is read as
 * Ana Ruiz. Only letters (of any script), spaces, hyphens, apostrophes and dots, two to five words at most.
 */
export function nameFromDisplayName(raw: string | null | undefined): ParsedName | null {
  if (typeof raw !== "string") return null;
  let name = raw.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 80 || name.includes("@") || NOT_A_PERSON.test(name)) return null;
  const comma = name.split(",");
  if (comma.length === 2 && comma[0]!.trim() && comma[1]!.trim()) name = `${comma[1]!.trim()} ${comma[0]!.trim()}`;
  else if (comma.length > 1) return null;
  if (!/^[\p{L}][\p{L}\p{M}'’.\- ]*$/u.test(name)) return null;
  const words = name.split(" ");
  if (words.length > 5) return null;
  // A name in ALL CAPS is how systems and mailing tools write; a person's mail client keeps what they typed.
  if (name === name.toUpperCase() && name.length > 3 && words.length > 1) return null;
  const [first, ...rest] = words;
  return { firstName: first!, lastName: rest.length ? rest.join(" ") : null };
}

/** The company domain of an address, or `null` for a free mail provider or something that is not an address. */
export function companyDomainOf(address: string): string | null {
  const domain = address.split("@")[1]?.trim().toLowerCase();
  if (!domain || !domain.includes(".") || FREE_MAIL.has(domain)) return null;
  return domain;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * `crm:message.received` → the observations it makes about the sender. Never throws for a message it cannot
 * use: a message without a sender, from the mailbox itself, from an address that is not one contact, or with
 * the `mail-header` kind switched off records nothing.
 */
export async function mailEvidence(db: CrmDb, payload: unknown): Promise<ObservationOutcome[]> {
  const p = (payload ?? {}) as Record<string, unknown>;
  const messageId = str(p.messageId);
  const from = normalizeEmail(str(p.from));
  if (!messageId || !from || p.direction !== "in") return [];
  const own = new Set((Array.isArray(p.mailboxAddresses) ? p.mailboxAddresses : []).map((a) => normalizeEmail(str(a))));
  if (own.has(from)) return [];

  const contacts = await db
    .select({ id: crmContacts.id, companyId: crmContacts.companyId })
    .from(crmContacts)
    .where(sql`lower(${crmContacts.email}) = ${from}`)
    .limit(2);
  // Two contacts with one address is a duplicate for a person to merge, not a person to describe.
  if (contacts.length !== 1) return [];
  const contact = contacts[0]!;

  const facts: Array<{ entityType: "contact" | "company"; entityId: string; field: string; value: string }> = [];
  const name = nameFromDisplayName(str(p.fromName));
  if (name) {
    facts.push({ entityType: "contact", entityId: contact.id, field: "firstName", value: name.firstName });
    if (name.lastName) facts.push({ entityType: "contact", entityId: contact.id, field: "lastName", value: name.lastName });
  }
  const domain = companyDomainOf(from);
  if (domain && contact.companyId) {
    const [company] = await db.select({ id: crmCompanies.id }).from(crmCompanies).where(sql`${crmCompanies.id} = ${contact.companyId}`).limit(1);
    if (company) facts.push({ entityType: "company", entityId: company.id, field: "domain", value: domain });
  }

  const outcomes: ObservationOutcome[] = [];
  for (const fact of facts) {
    try {
      outcomes.push(
        await observe(db, { ...fact, source: SOURCE, evidence: MAIL_EVIDENCE, externalRef: `mail:${messageId}:${fact.entityType}.${fact.field}` }, null)
      );
    } catch {
      // The kind was switched off, or the record went away while the message was synced: nothing to record.
      return outcomes;
    }
  }
  return outcomes;
}
