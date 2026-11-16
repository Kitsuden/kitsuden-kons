/**
 * kon-dc's public extension API
 * ============================================================================
 *
 * How another package adds to kon-dc without kon-dc knowing it exists. kon-dc never imports an
 * extension: an extension imports this module and registers itself (kon-dc's Enterprise edition does:
 * AI credits and per-server keys, Wick-level security, branded bots, a marketplace, billing). With no
 * extension registered, kon-dc behaves exactly as it does alone.
 *
 * Hooks (all optional; the first extension that answers wins where only one answer makes sense):
 *
 *   modules         more modules, offered to every server like the built-in ones.
 *   ai              which AI answers for a server: a runner (a server's own key, credits), a sentence
 *                   to refuse ("No AI credits left this month."), or null for the core's agents.
 *   afterAi         told after every AI answer, for metering. Never blocks the answer.
 *   botFor          Discord credentials for a server (a branded bot) instead of the installation's.
 *   publicKeys      more application public keys interactions may be signed with (branded bots).
 *   onEvent         sees each gateway event before the modules; "drop" stops it there (a quarantined
 *                   member, a raid). A hook that throws lets the event through: the modules still run.
 *   onStaffAction   told about every change the team makes through the API (an audit log).
 *   templates       more ready-made blueprints (a marketplace's packages).
 *   isPremium       whether a server is premium, from a billing system; null = the kon's own table.
 *
 * Keep hooks fast: `onEvent` and `ai` run on the bot's hottest paths.
 */

import type { DcModule, DcEvent } from "./dc.modules";
import type { DiscordRest, DiscordSettings } from "./dc.rest";
import type { BlueprintTemplate } from "./dc.templates";

/** What an AI call is for: the builder in the admin, `/ask`, a blueprint's `ask_agent` step, a module. */
export type AiPurpose = "builder" | "ask" | "step" | "module";

export interface AiRequest {
  /** null for the admin's builder when no server is chosen. */
  guildId: string | null;
  userId: string | null;
  purpose: AiPurpose;
  /** The module or blueprint asking, when there is one. */
  moduleId?: string;
  /** The core agent the call names (the default runner uses it). */
  agentId: string;
}

/** The part of the core's agents kon-dc uses. */
export interface AiRunner {
  run(request: { agentId: string; message: string; allowedTools?: string[]; context?: string }): Promise<{ response?: string | null }>;
}

export interface AiUsage extends AiRequest {
  ok: boolean;
  /** Characters sent and received: a provider-neutral measure for metering. */
  inputChars: number;
  outputChars: number;
  ms: number;
}

export type BotCredentials = Partial<Pick<DiscordSettings, "botToken" | "applicationId" | "publicKey">>;

export interface StaffAction {
  /** `module.switched`, `plan.set`, `balance.set`, `schedule.cancelled`, `blueprint.created`… */
  kind: string;
  guildId: string | null;
  /** The user or agent who did it, as the core knows them. */
  actor: { id: string | null; kind: "user" | "agent" | "system" };
  detail: Record<string, unknown>;
}

export interface DcExtension {
  /** Unique: registering the same name again replaces it. */
  name: string;
  modules?: DcModule[];
  ai?(request: AiRequest): AiRunner | string | null | Promise<AiRunner | string | null>;
  afterAi?(usage: AiUsage): void | Promise<void>;
  botFor?(guildId: string): BotCredentials | null;
  publicKeys?(): string[];
  onEvent?(event: DcEvent, tools: { rest: DiscordRest }): void | "drop" | Promise<void | "drop">;
  onStaffAction?(action: StaffAction): void | Promise<void>;
  templates?(): BlueprintTemplate[];
  isPremium?(guildId: string): boolean | null | Promise<boolean | null>;
}

/**
 * The registry lives on `globalThis` under a registered symbol, not in this module: a host can load
 * two copies of kon-dc (the one it mounted, the one an extension's `import` resolved to), and an
 * extension must reach the one that runs. `registryId()` lets an extension check it did.
 */
const KEY = Symbol.for("kitsuden.kon-dc.extensions.v1");
type Registry = { map: Map<string, DcExtension>; id: string };
const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
const registry: Registry = (holder[KEY] ??= { map: new Map<string, DcExtension>(), id: Math.random().toString(36).slice(2) });

/** The shared registry's id: the same in every copy of kon-dc loaded in this process. */
export function registryId(): string {
  return registry.id;
}

/**
 * Adds (or replaces) an extension; its modules join the module registry. Returns a function that
 * removes the extension (its modules stay registered: servers may have them on).
 */
export function registerDcExtension(extension: DcExtension, registerModule: (module: DcModule) => void): () => void {
  if (!extension?.name) throw new TypeError("A kon-dc extension needs a name");
  for (const module of extension.modules ?? []) registerModule(module);
  registry.map.set(extension.name, extension);
  return () => {
    if (registry.map.get(extension.name) === extension) registry.map.delete(extension.name);
  };
}

export function dcExtensions(): readonly DcExtension[] {
  return [...registry.map.values()];
}

// ── What kon-dc asks the extensions ─────────────────────────────────────────────────────────────

/** The AI for a request: an extension's runner or refusal, else the core's agents (or none). */
export async function aiFor(request: AiRequest, core: AiRunner | null | undefined): Promise<AiRunner | string | null> {
  for (const ext of registry.map.values()) {
    if (!ext.ai) continue;
    const answer = await ext.ai(request);
    if (answer !== null && answer !== undefined) return answer;
  }
  return core ?? null;
}

/**
 * Runs one AI call through `aiFor`, reports usage to `afterAi`, and returns the answer text or a
 * refusal: `{ text }` on success, `{ refused }` when there is no AI or an extension said no.
 */
export async function runAi(
  request: AiRequest,
  core: AiRunner | null | undefined,
  call: { message: string; allowedTools?: string[]; context?: string }
): Promise<{ text: string } | { refused: string }> {
  const runner = await aiFor(request, core);
  if (runner === null) return { refused: "AI answers are not available on this server." };
  if (typeof runner === "string") return { refused: runner };
  const started = Date.now();
  let ok = false;
  let out = "";
  try {
    const result = await runner.run({ agentId: request.agentId, message: call.message, allowedTools: call.allowedTools ?? [], context: call.context });
    out = result.response ?? "";
    ok = true;
    return { text: out };
  } finally {
    const usage: AiUsage = {
      ...request,
      ok,
      inputChars: call.message.length + (call.context?.length ?? 0),
      outputChars: out.length,
      ms: Date.now() - started,
    };
    for (const ext of registry.map.values()) {
      if (!ext.afterAi) continue;
      try {
        await ext.afterAi(usage);
      } catch {
        // Metering never breaks an answer.
      }
    }
  }
}

/** Credentials for a server's bot: the first extension's, merged over the installation's. */
export function settingsForGuild(base: DiscordSettings, guildId: string | null | undefined): DiscordSettings {
  if (!guildId) return base;
  for (const ext of registry.map.values()) {
    const bot = ext.botFor?.(guildId);
    if (bot) return { ...base, ...Object.fromEntries(Object.entries(bot).filter(([, v]) => v)) };
  }
  return base;
}

/** Every public key an interaction may be signed with: the installation's, then the extensions'. */
export function publicKeysOf(base: string | null | undefined): string[] {
  const keys = base ? [base] : [];
  for (const ext of registry.map.values()) for (const k of ext.publicKeys?.() ?? []) if (k && !keys.includes(k)) keys.push(k);
  return keys;
}

/** "drop" when an extension stops the event before the modules. A hook that throws does not. */
export async function eventVerdict(event: DcEvent, tools: { rest: DiscordRest }, warn: (message: string) => void): Promise<"drop" | null> {
  for (const ext of registry.map.values()) {
    if (!ext.onEvent) continue;
    try {
      if ((await ext.onEvent(event, tools)) === "drop") return "drop";
    } catch (err) {
      warn(`${ext.name} failed on a ${event.type} event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

/** Tells every extension; one that throws does not undo the change (it already happened). */
export async function reportStaffAction(action: StaffAction, warn: (message: string) => void): Promise<void> {
  for (const ext of registry.map.values()) {
    if (!ext.onStaffAction) continue;
    try {
      await ext.onStaffAction(action);
    } catch (err) {
      warn(`${ext.name} failed on a staff action (${action.kind}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export function extensionTemplates(): BlueprintTemplate[] {
  return [...registry.map.values()].flatMap((ext) => ext.templates?.() ?? []);
}

/** The first extension's answer, or null to use the kon's own plan table. */
export async function premiumFromExtensions(guildId: string): Promise<boolean | null> {
  for (const ext of registry.map.values()) {
    if (!ext.isPremium) continue;
    const answer = await ext.isPremium(guildId);
    if (answer !== null && answer !== undefined) return answer;
  }
  return null;
}
