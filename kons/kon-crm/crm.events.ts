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
 */

import type { KonEvents } from "@kitsuden/shared";

let sink: KonEvents | null = null;

/** Set once, when the kon's operations are built. */
export function useCrmEvents(events: KonEvents | undefined): void {
  sink = events ?? null;
}

export function emitCrm(name: string, data: Record<string, unknown>): void {
  sink?.emit(`crm:${name}`, data);
}
