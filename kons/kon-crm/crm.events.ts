/**
 * What the CRM announces
 * ============================================================================
 *
 * Events are how something outside the kon reacts to it: a core action listening to `crm:deal:created` can wake
 * an agent, call a webhook or send a notice, without the CRM knowing who listens. The host announces them only
 * after the request's writes are committed.
 *
 * Payloads carry ids and states, never amounts, notes or field values: whoever reacts reads the record with its
 * own access, so an event never shows more than the reader may see.
 *
 *   crm:deal:created            { dealId, pipelineId, stageId }
 *   crm:deal:stage-changed      { dealId, fromStageId, toStageId }
 *   crm:deal:status-changed     { dealId, status }                     open, won, lost
 *   crm:contact:created         { contactId, origin }
 *   crm:email:received          { activityIds, contactIds, direction }
 *   crm:observation:suggested   { observationId, entityType, entityId, field }   waits for a person
 *   crm:observation:applied     { observationId, entityType, entityId, field }
 *
 * ── THE NEW NAMES ───────────────────────────────────────────────────────────
 *
 * Kitsuden names a new event `<source>:<entity>.<what-happened>` (docs/kons/events.md). The four the
 * other kons and the automation rules care about most are also sent under that name, right after the
 * old one. The old names stay: a stored rule listens to them, and renaming an event breaks it silently.
 *
 *   crm:contact.created         { contactId, origin }                  with contact:created
 *   crm:deal.moved              { dealId, fromStageId, toStageId }     with deal:stage-changed
 *   crm:deal.won                { dealId }                             with deal:status-changed → won
 *   crm:deal.lost               { dealId, lostReason }                 with deal:status-changed → lost
 */

import type { KonEvents } from "@kitsuden/shared";

let sink: KonEvents | null = null;

/** Set once, when the kon's operations are built. */
export function useCrmEvents(events: KonEvents | undefined): void {
  sink = events ?? null;
}

export function emitCrm(name: string, data: Record<string, unknown>): void {
  if (!sink) return;
  sink.emit(`crm:${name}`, data);
  for (const [alias, payload] of aliasesOf(name, data)) sink.emit(alias, payload);
}

/** The new-style names an old event is also sent as (see THE NEW NAMES above). */
export function aliasesOf(name: string, data: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  switch (name) {
    case "contact:created":
      return [["crm:contact.created", data]];
    case "deal:stage-changed":
      return [["crm:deal.moved", data]];
    case "deal:status-changed":
      if (data.status === "won") return [["crm:deal.won", { dealId: data.dealId }]];
      if (data.status === "lost") {
        return [["crm:deal.lost", { dealId: data.dealId, lostReason: data.lostReason ?? null }]];
      }
      return [];
    default:
      return [];
  }
}

/**
 * What the CRM emits and listens to, in the shape `defineKon({ events })` takes
 * (`KonEventsDeclaration` in Kitsuden). A host that does not read the field yet ignores it.
 */
export const CRM_EVENTS = {
  emits: {
    "crm:contact.created": {
      description: "A contact was created, by a person, a form, an import, an email or another kon.",
      payload: { contactId: "id of the contact", origin: "manual, import, form, email, agent or automation" },
    },
    "crm:deal.moved": {
      description: "A deal moved to another stage of its pipeline.",
      payload: { dealId: "id of the deal", fromStageId: "stage it left", toStageId: "stage it entered" },
    },
    "crm:deal.won": {
      description: "A deal was marked as won.",
      payload: { dealId: "id of the deal" },
    },
    "crm:deal.lost": {
      description: "A deal was marked as lost.",
      payload: { dealId: "id of the deal", lostReason: "the reason given, or null" },
    },
    "crm:quote.sent": { description: "A quote was marked as sent.", payload: { quoteId: "id", dealId: "id", number: "Q-0001" } },
    "crm:quote.accepted": {
      description: "A quote was accepted; `then` says whether it opened a payment or asks for an order.",
      payload: {
        quoteId: "id",
        dealId: "id",
        number: "Q-0001",
        then: "none, payment or order",
        lines: "the quote's lines (name, productType, productId, quantity, unitPrice in cents…)",
        total: "cents",
        currency: "ISO code",
        customerEmail: "the deal contact's email",
      },
    },
    "crm:quote.rejected": { description: "A quote was marked as rejected.", payload: { quoteId: "id", dealId: "id", number: "Q-0001" } },
    "crm:address.suppressed": { description: "An email or a domain was put on the CRM's exclusion list.", payload: { kind: "email or domain", value: "the address or domain" } },
    "crm:address.unsuppressed": { description: "An entry was taken off the CRM's exclusion list.", payload: { kind: "email or domain", value: "the address or domain" } },
    "crm:deal:created": { description: "A deal was created.", payload: { dealId: "id", pipelineId: "id", stageId: "id" } },
    "crm:deal:stage-changed": { description: "Old name of crm:deal.moved.", payload: { dealId: "id", fromStageId: "id", toStageId: "id" } },
    "crm:deal:status-changed": { description: "A deal's status changed (open, won, lost).", payload: { dealId: "id", status: "open, won or lost" } },
    "crm:contact:created": { description: "Old name of crm:contact.created.", payload: { contactId: "id", origin: "where it came from" } },
    "crm:email:received": { description: "Emails were copied to contacts.", payload: { activityIds: "ids", contactIds: "ids", direction: "in or out" } },
    "crm:observation:suggested": { description: "An observation waits for a person.", payload: { observationId: "id", entityType: "contact, company or deal", entityId: "id", field: "field" } },
    "crm:observation:applied": { description: "An observation was applied.", payload: { observationId: "id", entityType: "contact, company or deal", entityId: "id", field: "field" } },
  },
  listens: [
    "shop:order.paid",
    "newsletter:member.subscribed",
    "payment:payment.succeeded",
    "payment:payment.refunded",
    "inbox:message.received",
    "inbox:event.synced",
    "newsletter:address.suppressed",
    "newsletter:address.unsuppressed",
  ],
};
