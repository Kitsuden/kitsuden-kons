/**
 * koe's public extension API
 * ============================================================================
 *
 * How another package adds to koe without koe knowing it exists. koe never imports an extension; an
 * extension imports this module and registers itself (the koe Enterprise edition does so: audit log,
 * retention, contact rules). Without any extension registered, koe behaves exactly as it does alone.
 *
 * Two hooks, both awaited, both inside the request or job transaction that triggered them:
 *
 *   beforeSend  asked by send() and again by the delivery job. Return a sentence to refuse the message
 *               (send() answers 409 with `details.koe: "POLICY"`; delivery marks it failed), or null.
 *               A hook that throws refuses too: a policy that cannot be checked does not let a message out.
 *   onAccess    told when someone reads or changes a conversation or a contact. If it throws, the request
 *               fails: an audit trail that cannot be written must not be skipped silently.
 *
 * Keep hooks fast: they run on the inbox's hottest paths.
 */

import type { KonContext } from "@kitsuden/shared";

import type { Db } from "./koe.common";
import type { AuthorKind, Channel, Contact, Conversation } from "./koe.schema";

export interface SendCheck {
  ctx: KonContext;
  db: Db;
  /** `send`: before the message is stored. `deliver`: right before it goes to the channel. */
  stage: "send" | "deliver";
  conversation: Conversation;
  channel: Channel;
  contact: Contact | null;
  message: {
    kind: string;
    authorKind: AuthorKind;
    authorId: string | null;
    /** For templates: marketing, utility or authentication. */
    templateCategory: string | null;
    body: string | null;
  };
  now: Date;
}

export type AccessKind = "view" | "messages" | "send" | "state" | "note" | "contact-view" | "contact-update";

export interface AccessEvent {
  ctx: KonContext;
  db: Db;
  kind: AccessKind;
  conversationId: string | null;
  contactId: string | null;
  actor: { kind: string; id: string | null };
  detail?: Record<string, unknown>;
}

export interface KoeExtension {
  /** Unique: registering the same name again replaces it. */
  name: string;
  beforeSend?(check: SendCheck): string | null | Promise<string | null>;
  onAccess?(event: AccessEvent): void | Promise<void>;
}

const registered = new Map<string, KoeExtension>();

/** Adds (or replaces) an extension. Returns a function that removes it. */
export function registerKoeExtension(extension: KoeExtension): () => void {
  if (!extension?.name) throw new TypeError("A koe extension needs a name");
  registered.set(extension.name, extension);
  return () => {
    if (registered.get(extension.name) === extension) registered.delete(extension.name);
  };
}

export function koeExtensions(): readonly KoeExtension[] {
  return [...registered.values()];
}

/** The first refusal any extension gives, or null. */
export async function checkSend(check: SendCheck): Promise<string | null> {
  for (const ext of registered.values()) {
    if (!ext.beforeSend) continue;
    try {
      const reason = await ext.beforeSend(check);
      if (reason) return reason;
    } catch (err) {
      return `${ext.name} could not check this message (${err instanceof Error ? err.message : "error"})`;
    }
  }
  return null;
}

export async function reportAccess(event: AccessEvent): Promise<void> {
  for (const ext of registered.values()) if (ext.onAccess) await ext.onAccess(event);
}
