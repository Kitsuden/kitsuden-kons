/**
 * The CRM's inbox — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "crm-inbox" policy.
 *
 * Everything here is someone's mail. A person works on their own mailboxes; row security
 * (migrations/0015_inbox.sql) is what keeps them apart, and lets admins and editors READ only what its
 * owner marked `team`. An agent acts only as the person it acts for (`actsAsUserIn`); sending as them is
 * `sensitive`, so an agent's send waits for a person.
 */
import { actsAsUserIn, definePolicy } from "@kitsuden/engine";

export function registerInboxPolicy(): void {
  // An agent acts for a person when it may act as them, or holds a CRM scope (`crm:*`, `kon:crm:<id>`).
  definePolicy<Record<string, never>>("crm-inbox", {
    actAsUser: actsAsUserIn("crm"),
    send: actsAsUserIn("crm"),
  });
}

registerInboxPolicy();
