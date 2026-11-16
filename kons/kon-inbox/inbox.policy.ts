/**
 * Inbox — Authorization Policy
 * ============================================================================
 * Deny-by-default. Importing this module registers the "inbox" policy.
 *
 * Everything here is someone's mail. A person works on their own mailboxes; row security
 * (migrations/0001_inbox.sql) is what keeps them apart, and lets admins and editors READ only what its
 * owner marked `team`. An agent acts only as the person it acts for (`actsAsUserIn`); sending as them is
 * `sensitive`, so an agent's send waits for a person.
 */
import { actsAsUserIn, definePolicy } from "@kitsuden/engine";

export function registerInboxPolicy(): void {
  definePolicy<Record<string, never>>("inbox", {
    actAsUser: actsAsUserIn("inbox"),
    send: actsAsUserIn("inbox"),
  });
}

registerInboxPolicy();
