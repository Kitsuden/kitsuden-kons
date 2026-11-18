/**
 * WhatsApp message templates: the local copy, its status, and filling it in
 * ============================================================================
 *
 * Templates live in Meta (per WhatsApp Business Account) and are approved there. koe keeps a copy with its
 * status, category, language and components, refreshed by `syncTemplates()` and by the
 * `message_template_status_update` / `message_template_quality_update` webhooks. Only an `approved`
 * template can be sent.
 *
 * Variables: positional (`{{1}}`, `{{2}}`) or named (`{{order_id}}`) in the header and body; dynamic URL
 * buttons take one more; a copy-code button takes the code. Values can reference the contact
 * (`{{contact.name}}`, `{{contact.phone}}`, `{{contact.attributes.plan}}`), so a campaign can fill each
 * recipient's own.
 */

import { AppError } from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import { createWhatsAppTemplate, deleteWhatsAppTemplate, listWhatsAppTemplates } from "./channels/whatsapp";
import { authOf } from "./koe.channels";
import { emit, newId, type Db } from "./koe.common";
import { koeChannels, koeTemplates, type Channel, type Contact, type Template, type TemplateComponent } from "./koe.schema";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** The placeholders a piece of text uses, in order of first appearance. */
export function placeholdersOf(text: string | undefined): string[] {
  if (!text) return [];
  const seen: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (!seen.includes(m[1]!)) seen.push(m[1]!);
  return seen;
}

export interface TemplateSlots {
  header: string[];
  /** The header is a media: it needs an image, video or document. */
  headerMedia: "IMAGE" | "VIDEO" | "DOCUMENT" | null;
  body: string[];
  /** Index → placeholder of a dynamic URL button. */
  urlButtons: Array<{ index: number; slot: string }>;
  copyCode: number | null;
}

export function slotsOf(components: TemplateComponent[]): TemplateSlots {
  const header = components.find((c) => c.type === "HEADER");
  const body = components.find((c) => c.type === "BODY");
  const buttons = components.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  const urlButtons: TemplateSlots["urlButtons"] = [];
  let copyCode: number | null = null;
  buttons.forEach((b, index) => {
    if (b.type === "URL" && b.url && placeholdersOf(b.url).length) urlButtons.push({ index, slot: `button_${index}` });
    if (b.type === "COPY_CODE") copyCode = index;
  });
  return {
    header: header?.format === "TEXT" || !header?.format ? placeholdersOf(header?.text) : [],
    headerMedia: header?.format && ["IMAGE", "VIDEO", "DOCUMENT"].includes(header.format) ? (header.format as "IMAGE" | "VIDEO" | "DOCUMENT") : null,
    body: placeholdersOf(body?.text),
    urlButtons,
    copyCode,
  };
}

/** `{{contact.name}}` and friends inside a value. Unknown references become empty. */
export function resolveValue(value: string, contact: Partial<Contact> | null, extra: Record<string, string> = {}): string {
  return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    if (path in extra) return extra[path]!;
    const [root, key, sub] = path.split(".");
    if (root !== "contact" || !contact) return "";
    if (key === "name") return contact.displayName ?? "";
    if (key === "phone") return contact.phone ?? "";
    if (key === "email") return contact.email ?? "";
    if (key === "attributes" && sub) {
      const v = (contact.attributes as Record<string, unknown> | undefined)?.[sub];
      return v === undefined || v === null ? "" : String(v);
    }
    return "";
  });
}

export interface FillInput {
  /** Slot → value. Positional slots are "1", "2"…; URL buttons "button_<index>"; the copy-code button "code". */
  values: Record<string, string>;
  /** A media header: the WhatsApp media id or a link. */
  headerMedia?: { id?: string; link?: string; filename?: string };
}

export interface Filled {
  components: unknown[];
  /** What the conversation shows. */
  preview: string;
}

/** Template + values → the components WhatsApp expects. Throws 422 naming every missing value. */
export function fillTemplate(t: Pick<Template, "components" | "name">, input: FillInput, contact: Partial<Contact> | null = null): Filled {
  const slots = slotsOf(t.components);
  const value = (slot: string) => resolveValue(input.values[slot] ?? "", contact).trim();
  const missing = [...slots.header, ...slots.body, ...slots.urlButtons.map((b) => b.slot), ...(slots.copyCode !== null ? ["code"] : [])].filter((s) => !value(s));
  if (slots.headerMedia && !input.headerMedia?.id && !input.headerMedia?.link) missing.push("headerMedia");
  if (missing.length) throw AppError.validation(`The template "${t.name}" needs: ${missing.join(", ")}`);

  const param = (slot: string) => (/^\d+$/.test(slot) ? { type: "text", text: value(slot) } : { type: "text", parameter_name: slot, text: value(slot) });
  const components: unknown[] = [];
  if (slots.headerMedia) {
    const kind = slots.headerMedia.toLowerCase();
    const media = input.headerMedia!.id ? { id: input.headerMedia!.id } : { link: input.headerMedia!.link };
    components.push({ type: "header", parameters: [{ type: kind, [kind]: { ...media, ...(kind === "document" && input.headerMedia?.filename ? { filename: input.headerMedia.filename } : {}) } }] });
  } else if (slots.header.length) {
    components.push({ type: "header", parameters: slots.header.map(param) });
  }
  if (slots.body.length) components.push({ type: "body", parameters: slots.body.map(param) });
  for (const b of slots.urlButtons) components.push({ type: "button", sub_type: "url", index: String(b.index), parameters: [{ type: "text", text: value(b.slot) }] });
  if (slots.copyCode !== null) components.push({ type: "button", sub_type: "copy_code", index: String(slots.copyCode), parameters: [{ type: "coupon_code", coupon_code: value("code") }] });

  const text = (c: TemplateComponent | undefined) => (c?.text ?? "").replace(PLACEHOLDER, (_, s: string) => value(s));
  const preview = [text(t.components.find((c) => c.type === "HEADER")), text(t.components.find((c) => c.type === "BODY")), t.components.find((c) => c.type === "FOOTER")?.text]
    .filter(Boolean)
    .join("\n");
  return { components, preview };
}

// ── Keeping the copy in step with Meta ──────────────────────────────────────

const STATUS = new Set(["approved", "pending", "rejected", "paused", "disabled", "in_appeal", "deleted"]);
const statusOf = (s: unknown) => {
  const v = String(s ?? "").toLowerCase();
  if (v === "pending_deletion") return "deleted";
  return STATUS.has(v) ? v : "pending";
};
const categoryOf = (c: unknown) => {
  const v = String(c ?? "").toLowerCase();
  return v === "marketing" || v === "authentication" ? v : "utility";
};

export async function syncTemplates(ctx: KonContext, db: Db, channel: Channel): Promise<{ synced: number }> {
  if (channel.kind !== "whatsapp") throw AppError.validation("Only WhatsApp channels have templates");
  if (!channel.accountId) throw AppError.validation("Set the channel's WhatsApp Business Account id (accountId) first");
  const auth = await authOf(ctx, channel, "sync-templates");
  const remote = await listWhatsAppTemplates(auth.accessToken, channel.accountId, auth.graphVersion);
  const now = new Date();
  for (const r of remote) {
    const values = {
      externalId: String(r.id ?? ""),
      category: categoryOf(r.category) as Template["category"],
      status: statusOf(r.status) as Template["status"],
      components: (Array.isArray(r.components) ? r.components : []) as TemplateComponent[],
      quality: String((r.quality_score as { score?: string } | undefined)?.score ?? "").toLowerCase() || null,
      rejectedReason: r.rejected_reason && r.rejected_reason !== "NONE" ? String(r.rejected_reason) : null,
      syncedAt: now,
    };
    await db
      .insert(koeTemplates)
      .values({ id: newId(), channelId: channel.id, name: String(r.name), language: String(r.language), ...values })
      .onConflictDoUpdate({ target: [koeTemplates.channelId, koeTemplates.name, koeTemplates.language], set: values });
  }
  return { synced: remote.length };
}

export async function createTemplate(
  ctx: KonContext,
  db: Db,
  channel: Channel,
  input: { name: string; language: string; category: "marketing" | "utility" | "authentication"; components: TemplateComponent[] }
): Promise<Template> {
  if (channel.kind !== "whatsapp" || !channel.accountId) throw AppError.validation("Templates need a WhatsApp channel with its accountId");
  const auth = await authOf(ctx, channel, "create-template");
  const created = await createWhatsAppTemplate(auth.accessToken, channel.accountId, auth.graphVersion, input);
  const [row] = (await db
    .insert(koeTemplates)
    .values({
      id: newId(),
      channelId: channel.id,
      externalId: created.id,
      name: input.name,
      language: input.language,
      // Meta may recategorise it on approval; the status webhook tells.
      category: categoryOf(created.category ?? input.category) as Template["category"],
      status: statusOf(created.status) as Template["status"],
      components: input.components,
      syncedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [koeTemplates.channelId, koeTemplates.name, koeTemplates.language],
      set: { externalId: created.id, status: statusOf(created.status) as Template["status"], components: input.components, syncedAt: new Date() },
    })
    .returning()) as Template[];
  return row!;
}

export async function deleteTemplate(ctx: KonContext, db: Db, template: Template): Promise<void> {
  const [channel] = (await db.select().from(koeChannels).where(eq(koeChannels.id, template.channelId)).limit(1)) as Channel[];
  if (channel?.accountId) {
    const auth = await authOf(ctx, channel, "delete-template");
    await deleteWhatsAppTemplate(auth.accessToken, channel.accountId, auth.graphVersion, template.name);
  }
  await db.update(koeTemplates).set({ status: "deleted" }).where(eq(koeTemplates.id, template.id));
}

/** The status webhook: every channel of that WABA with a template of that name (and language) is updated. */
export async function applyTemplateStatus(
  ctx: KonContext,
  db: Db,
  e: { accountId: string; name: string; language?: string; status?: string; quality?: string; reason?: string; templateExternalId?: string }
): Promise<void> {
  const channels = (await db.select().from(koeChannels).where(and(eq(koeChannels.kind, "whatsapp"), eq(koeChannels.accountId, e.accountId)))) as Channel[];
  for (const channel of channels) {
    const where = and(eq(koeTemplates.channelId, channel.id), eq(koeTemplates.name, e.name), ...(e.language ? [eq(koeTemplates.language, e.language)] : []));
    const set: Record<string, unknown> = {};
    if (e.status) {
      set.status = statusOf(e.status);
      set.rejectedReason = e.reason && e.reason !== "NONE" ? e.reason : null;
    }
    if (e.quality) set.quality = e.quality;
    if (Object.keys(set).length === 0) continue;
    const updated = (await db.update(koeTemplates).set(set).where(where).returning({ id: koeTemplates.id })) as Array<{ id: string }>;
    for (const u of updated) {
      emit(ctx, "template.status_changed", { templateId: u.id, channelId: channel.id, name: e.name, language: e.language ?? null, status: set.status ?? null, quality: e.quality ?? null, reason: e.reason ?? null });
    }
  }
}
