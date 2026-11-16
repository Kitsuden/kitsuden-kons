/** What the view reads from kon-dc's routes (only the fields it uses). */

import type { JsonSchema } from "$lib/components";

export interface ViewContext {
  apiBase?: string;
  theme?: "light" | "dark";
  locale?: string;
}

export interface Status {
  configured: { publicKey: boolean; applicationId: boolean; botToken: boolean; kitsudenApi: boolean };
  interactionsUrl: string;
  inviteUrl: string | null;
  disabledModules: string[];
  stats: {
    interactions?: number;
    gatewayEvents?: number;
    konEvents?: number;
    dropped?: number;
    queued?: number;
    running?: number;
    lastGatewayBatchAt?: string | null;
    subscribedEvents?: string[];
  };
}

export interface Guild {
  id: string;
  name: string;
  leftAt: string | null;
  createdAt: string;
}

export interface ModuleState {
  id: string;
  name: string;
  description: string;
  intents: number;
  events: string[];
  configSchema: JsonSchema & Record<string, unknown>;
  panels: string[];
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface SlashCommand {
  name: string;
  description: string;
  options?: Array<{ name: string; type: number; options?: unknown[] }>;
}

export interface Panel {
  messageId: string;
  guildId: string;
  channelId: string;
  moduleId: string;
  panelId: string;
  createdAt: string;
  refreshedAt: string | null;
}

export interface Blueprint {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "published";
  revision: number;
  definition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id: string;
  name: string;
  description: string;
  needs: { kons: string[]; scopes: string[] };
  optionsSchema: JsonSchema & Record<string, unknown>;
}

export interface Validation {
  valid: boolean;
  problems: Array<{ path: string; message: string }>;
  summary: { commands: number; triggers: number; modals: number; panels: number; components: number } | null;
}

/** One step of the catalog (GET /blueprints/steps). */
export interface StepEntry {
  do: string;
  label: string;
  category: string;
  description: string;
  example: Record<string, unknown> & { do: string };
  formSchema: JsonSchema;
  jsonFields: string[];
  numberFields: string[];
}

/** What POST /blueprints/generate answers. */
export interface Generated {
  definition: Record<string, unknown> | null;
  problems: Array<{ path: string; message: string }>;
  attempts: number;
}

/** A catalog item (GET /items). */
export interface CatalogItem {
  id: string;
  guildId: string | null;
  item: string;
  name: string;
  description: string | null;
  emoji: string | null;
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  kind: "item" | "consumable" | "role" | "badge" | "background" | "pet" | "furniture";
  imageUrl: string | null;
  color: string | null;
  price: number | null;
  currency: string;
  sellPrice: number | null;
  tradeable: boolean;
  stock: number | null;
  sold: number;
  roleId: string | null;
  dropWeight: number;
  enabled: boolean;
}

// ── What the admin manages beyond settings (dc.manage.ts) ──────────────────────

export interface DayPoint {
  date: string;
  messages: number;
  voiceMinutes: number;
}

export interface Ranked {
  userId: string;
  name: string | null;
  value: number;
}

export interface Overview {
  totals: {
    guilds: number;
    activeGuilds: number;
    modulesOn: number;
    blueprints: number;
    publishedBlueprints: number;
    items: number;
    premiumGuilds: number;
    members: number;
  };
  days: DayPoint[];
  topGuilds: { guildId: string; name: string; messages: number; voiceMinutes: number }[];
}

export interface Economy {
  currency: string;
  currencies: { currency: string; members: number; total: number }[];
  total: number;
  docs: Ranked[];
}

export interface MemberFile {
  userId: string;
  profile: { name: string | null; bio: string | null; rep: number; badges: string[]; dailyStreak: number } | null;
  balances: { currency: string; balance: number }[];
  items: { item: string; name: string | null; emoji: string | null; quantity: number }[];
  activity: { messages: number; voiceMinutes: number; days: DayPoint[] };
}

export interface Activity {
  days: DayPoint[];
  totals: { messages: number; voiceMinutes: number; members: number };
  topMessages: Ranked[];
  topVoice: Ranked[];
}

export interface ScheduleRow {
  id: string;
  moduleId: string;
  key: string;
  runAt: string;
  recurring: boolean;
  spec: Record<string, unknown> | null;
  payload: Record<string, unknown>;
}

export interface Plan {
  plan: "free" | "premium";
  until: string | null;
  source: string | null;
  active: boolean;
  premiumModules: string[];
  freeBlueprints: number | null;
}
