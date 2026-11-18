/**
 * The events koe emits, for automation rules, other kons and agents (docs/kons/events.md)
 * ============================================================================
 *
 * Delivery is after commit, in-process and at most once: they notify. Anything that must not be lost
 * (sending, downloading, notifying) goes through koe's queues instead.
 */

import type { KonEventsDeclaration } from "@kitsuden/shared";

const conv = { conversationId: "koe conversation id", channelId: "koe channel id" };

export const koeEvents: KonEventsDeclaration = {
  emits: {
    "koe:conversation.created": { description: "A conversation opened (a contact wrote first, or a person wrote first with a template).", payload: { ...conv, channelKind: "whatsapp | messenger | instagram | webchat", contactId: "koe contact id", state: "bot | queued | human", teamId: "team id or null" } },
    "koe:conversation.state_changed": { description: "Who answers changed: bot, queued, human, snoozed or resolved.", payload: { ...conv, from: "previous state", to: "new state", trigger: "handoff, assign, release, resolve…", assigneeId: "user id or null", teamId: "team id or null", contactId: "koe contact id" } },
    "koe:conversation.assigned": { description: "A person was given a conversation.", payload: { conversationId: "koe conversation id", assigneeId: "user id", teamId: "team id or null", by: "who assigned it" } },
    "koe:conversation.resolved": { description: "A conversation was resolved.", payload: { ...conv, teamId: "team id or null", assigneeId: "who had it" } },
    "koe:conversation.labeled": { description: "A conversation's labels changed.", payload: { conversationId: "koe conversation id", labels: "array of labels", by: "user id" } },
    "koe:handoff.requested": { description: "The bot (or the contact, or a rule) asked for a person.", payload: { ...conv, teamId: "team id or null", reason: "why" } },
    "koe:message.received": { description: "A contact sent a message.", payload: { messageId: "koe message id", ...conv, channelKind: "channel kind", contactId: "koe contact id", kind: "text, image, voice…", text: "the text, if any", state: "the conversation's state", assigneeId: "user id or null", teamId: "team id or null" } },
    "koe:message.sent": { description: "A message went out to the channel.", payload: { messageId: "koe message id", ...conv, kind: "message kind", authorKind: "agent, ai, bot, rule, campaign", authorId: "who" } },
    "koe:message.delivered": { description: "The channel delivered a message.", payload: { messageId: "koe message id", ...conv } },
    "koe:message.read": { description: "The contact read a message.", payload: { messageId: "koe message id", ...conv } },
    "koe:message.failed": { description: "A message could not be sent or delivered.", payload: { messageId: "koe message id", ...conv, code: "Meta's error code or koe's reason", error: "message", authorKind: "who sent it" } },
    "koe:window.expiring": { description: "The free window of a conversation closes soon (WhatsApp, Messenger, Instagram).", payload: { ...conv, expiresAt: "ISO date", assigneeId: "user id or null" } },
    "koe:window.closed": { description: "The free window closed: only templates (or the human-agent tag) from now.", payload: { ...conv } },
    "koe:template.status_changed": { description: "Meta approved, rejected, paused or disabled a template, or its quality changed.", payload: { templateId: "koe template id", channelId: "koe channel id", name: "template name", language: "code", status: "new status or null", quality: "new quality or null", reason: "Meta's reason" } },
    "koe:channel.quality_changed": { description: "A WhatsApp number's quality or messaging limit changed.", payload: { channelId: "koe channel id", quality: "green | yellow | red…", messagingLimit: "tier", detail: "Meta's detail" } },
    "koe:channel.connected": { description: "A channel was connected.", payload: { channelId: "koe channel id", kind: "channel kind" } },
    "koe:channel.broken": { description: "Meta refused a channel's credentials: someone must reconnect it.", payload: { channelId: "koe channel id", kind: "channel kind", code: "Meta's error code" } },
    "koe:contact.opted_in": { description: "A contact agreed to receive business-initiated messages on a channel.", payload: { contactId: "koe contact id", channelId: "koe channel id" } },
    "koe:contact.opted_out": { description: "A contact asked not to receive business-initiated messages on a channel.", payload: { contactId: "koe contact id", channelId: "koe channel id" } },
    "koe:contact.updated": { description: "A contact was edited.", payload: { contactId: "koe contact id", by: "user id" } },
    "koe:sla.breached": { description: "A conversation missed its team's first-response or resolution time.", payload: { ...conv, teamId: "team id", kind: "first_response | resolution", assigneeId: "user id or null" } },
    "koe:promise.created": { description: "A contact promised to pay (collections).", payload: { promiseId: "id", contactId: "koe contact id", conversationId: "or null", amountCents: "number", currency: "ISO 4217", dueDate: "YYYY-MM-DD" } },
    "koe:promise.kept": { description: "A payment promise was kept.", payload: { promiseId: "id", contactId: "koe contact id", amountCents: "number", currency: "ISO 4217" } },
    "koe:promise.broken": { description: "A payment promise was not kept by its date.", payload: { promiseId: "id", contactId: "koe contact id", amountCents: "number", currency: "ISO 4217", dueDate: "YYYY-MM-DD" } },
    "koe:outcome.recorded": { description: "The outcome of a sales or collections attempt was recorded.", payload: { conversationId: "koe conversation id", kind: "contacted, promise, paid, won, lost…", amountCents: "number or null" } },
    "koe:campaign.finished": { description: "A campaign sent to every recipient it could.", payload: { campaignId: "id", sent: "number", failed: "number", skipped: "number" } },
    "koe:campaign.started": { description: "An approved campaign started sending (its scheduled time came, or it was scheduled for now).", payload: { campaignId: "id", name: "campaign name" } },
    "koe:sequence.stopped": { description: "A follow-up sequence stopped before its last step (the contact replied, a person stopped it, opt-out…).", payload: { runId: "id", sequenceId: "id", conversationId: "koe conversation id", reason: "reply, stopped by a person, opted_out, sequence paused" } },
    "koe:sequence.finished": { description: "A follow-up sequence ran its last step.", payload: { runId: "id", sequenceId: "id", conversationId: "koe conversation id" } },
    "koe:flow.completed": { description: "A bot flow finished: it handed off, resolved, or reached its end. Carries what it captured.", payload: { conversationId: "koe conversation id", channelId: "koe channel id", flowId: "id", outcome: "handoff | resolved | ended", vars: "the variables the flow captured (email, phone…)" } },
  },
  listens: ["shop:order.paid", "payment:payment.succeeded", "crm:deal.won"],
};
