/**
 * kon-dc — the step catalog
 * ============================================================================
 *
 * What the block editor and a model writing blueprints need about each step: a name, a category,
 * what it does (the zod `.describe`), a valid example, and a FORM schema: the step's JSON Schema
 * simplified to what a form draws (`tallao`'s SchemaForm). Unions of a number and a template become
 * a text field (listed in `numberFields`, so the editor turns "5" back into 5); the parts that are
 * whole messages or step lists (`components`, the steps of a `later`) stay JSON (`jsonFields`).
 *
 * Served by `GET /api/dc/blueprints/steps` (public: no data) and used by `generateBlueprint`.
 */

import { z } from "@kitsuden/engine/zod";

import { BlueprintStep, type BlueprintDefinitionInput } from "./dc.contract";

export const STEP_CATEGORIES = ["Messages", "Discord", "Rewards", "Flow and data", "Kons and AI"] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number];

type Example = Record<string, unknown>;

const R = "333333333333333333";

/** Name, category and a valid example per step. A test parses every example. */
export const STEP_INFO: Record<string, { label: string; category: StepCategory; example: Example }> = {
  reply: { label: "Reply", category: "Messages", example: { do: "reply", content: "Hello, {{user.mention}}!", ephemeral: true } },
  update_message: { label: "Update the message", category: "Messages", example: { do: "update_message", content: "Updated by {{user.name}}" } },
  send_message: { label: "Send a message", category: "Messages", example: { do: "send_message", channelId: "$channel", content: "Something happened" } },
  dm: { label: "Direct message", category: "Messages", example: { do: "dm", content: "Thanks for joining, {{user.name}}!" } },
  open_modal: { label: "Open a form", category: "Messages", example: { do: "open_modal", modal: "form-1" } },
  poll: {
    label: "Poll",
    category: "Messages",
    example: { do: "poll", question: "Which game next?", answers: [{ text: "Tekken" }, { text: "2XKO" }], hours: 24 },
  },
  add_role: { label: "Give a role", category: "Discord", example: { do: "add_role", roleId: R } },
  remove_role: { label: "Take a role", category: "Discord", example: { do: "remove_role", roleId: R } },
  toggle_role: { label: "Toggle a role", category: "Discord", example: { do: "toggle_role", roleId: "{{value}}", saveAs: "change" } },
  timeout: { label: "Time out", category: "Discord", example: { do: "timeout", userId: "{{option.member}}", minutes: 10, reason: "Spam" } },
  kick: { label: "Kick", category: "Discord", example: { do: "kick", userId: "{{option.member}}", reason: "Rules" } },
  ban: { label: "Ban", category: "Discord", example: { do: "ban", userId: "{{option.member}}", reason: "Rules" } },
  set_nickname: { label: "Set a nickname", category: "Discord", example: { do: "set_nickname", nickname: "{{input.name}}" } },
  delete_message: { label: "Delete a message", category: "Discord", example: { do: "delete_message" } },
  pin_message: { label: "Pin a message", category: "Discord", example: { do: "pin_message" } },
  react: { label: "React", category: "Discord", example: { do: "react", emoji: "✅" } },
  create_thread: { label: "Open a thread", category: "Discord", example: { do: "create_thread", name: "ticket-{{user.name}}", private: true, saveAs: "thread" } },
  close_thread: { label: "Close a thread", category: "Discord", example: { do: "close_thread" } },
  card: {
    label: "Image card",
    category: "Rewards",
    example: { do: "card", kind: "rank" },
  },
  wallet_add: { label: "Give coins or XP", category: "Rewards", example: { do: "wallet_add", currency: "coins", amount: 50, saveAs: "balance" } },
  wallet_take: { label: "Charge a price", category: "Rewards", example: { do: "wallet_take", currency: "coins", amount: 100, else: "You need 100 coins." } },
  wallet_get: { label: "Read a balance", category: "Rewards", example: { do: "wallet_get", currency: "coins", saveAs: "balance" } },
  leaderboard: { label: "Leaderboard", category: "Rewards", example: { do: "leaderboard", currency: "coins", limit: 10, saveAs: "top" } },
  item_add: { label: "Give an item", category: "Rewards", example: { do: "item_add", item: "badge-champion", quantity: 1 } },
  item_take: { label: "Use up an item", category: "Rewards", example: { do: "item_take", item: "ticket", quantity: 1, else: "You need a ticket." } },
  slowmode: { label: "Slowmode", category: "Discord", example: { do: "slowmode", seconds: 30 } },
  activity_get: { label: "Read activity", category: "Rewards", example: { do: "activity_get", metric: "messages", days: 7, saveAs: "week" } },
  activity_top: { label: "Activity leaderboard", category: "Rewards", example: { do: "activity_top", metric: "messages", days: 7, saveAs: "top" } },
  item_random: { label: "Random catalog item", category: "Rewards", example: { do: "item_random", saveAs: "drop" } },
  item_transfer: { label: "Give an item to someone", category: "Rewards", example: { do: "item_transfer", item: "ticket", to: "{{option.member}}" } },
  item_use: { label: "Use an item", category: "Rewards", example: { do: "item_use", item: "potion" } },
  item_get: { label: "Count an item", category: "Rewards", example: { do: "item_get", item: "ticket", saveAs: "tickets" } },
  list_join: { label: "Join a list", category: "Rewards", example: { do: "list_join", list: "raffle", mode: "toggle", saveAs: "entry" } },
  list_pick: { label: "Draw from a list", category: "Rewards", example: { do: "list_pick", list: "raffle", count: 1, saveAs: "winner" } },
  list_count: { label: "Count a list", category: "Rewards", example: { do: "list_count", list: "raffle", saveAs: "entries" } },
  list_clear: { label: "Empty a list", category: "Rewards", example: { do: "list_clear", list: "raffle" } },
  stop: { label: "Stop (a check)", category: "Flow and data", example: { do: "stop", if: { left: "{{option.amount}}", op: "lt", right: "1" }, content: "At least 1." } },
  cooldown: { label: "Cooldown", category: "Flow and data", example: { do: "cooldown", seconds: 60, per: "user" } },
  set_var: { label: "Save a value", category: "Flow and data", example: { do: "set_var", name: "greeting", value: "Hi {{user.name|title}}" } },
  random: { label: "Random / loot table", category: "Flow and data", example: { do: "random", saveAs: "roll", min: 1, max: 6 } },
  math: { label: "Arithmetic", category: "Flow and data", example: { do: "math", saveAs: "total", expr: "{{var.roll}} * 10" } },
  later: { label: "Later", category: "Flow and data", example: { do: "later", minutes: 60, steps: [{ do: "dm", content: "Reminder!" }] } },
  kv_set: { label: "Remember a value", category: "Flow and data", example: { do: "kv_set", key: "last-winner", value: "{{user.id}}" } },
  kv_increment: { label: "Count up", category: "Flow and data", example: { do: "kv_increment", key: "uses", by: 1 } },
  kon_call: { label: "Call another kon", category: "Kons and AI", example: { do: "kon_call", method: "GET", path: "/blog?limit=1", saveAs: "posts" } },
  emit_event: { label: "Emit an event", category: "Kons and AI", example: { do: "emit_event", name: "quest:done", data: { user: "{{user.id}}" } } },
  post_panel: { label: "Post a live panel", category: "Kons and AI", example: { do: "post_panel", panel: "panel-1", channelId: "$channel" } },
  refresh_panels: { label: "Redraw panels", category: "Kons and AI", example: { do: "refresh_panels" } },
  ai_reply: { label: "Ask the AI", category: "Kons and AI", example: { do: "ai_reply", agentId: "support", prompt: "{{option.question}}" } },
};

type Schema = Record<string, unknown>;

/** Fields of a step that stay JSON in a form: whole messages and nested steps. */
const JSON_ONLY = new Set(["components", "steps"]);

function isNumberish(s: Schema): boolean {
  const any = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  return !!any && any.some((x) => x.type === "number" || x.type === "integer") && any.some((x) => x.type === "string");
}

/** A JSON Schema reduced to what SchemaForm draws. */
function simplify(s: Schema): Schema | null {
  if (s.$ref) return null;
  const any = (s.anyOf ?? s.oneOf) as Schema[] | undefined;
  if (any) {
    const types = new Set(any.map((x) => x.type ?? (typeof x.const === "string" ? "string" : undefined)));
    if (isNumberish(s)) return { type: "string", ...(s.description ? { description: `${s.description} (a number or a {{placeholder}})` } : { description: "A number or a {{placeholder}}" }) };
    if ([...types].every((t) => t === "string")) return { type: "string", ...(s.description ? { description: s.description } : {}) };
    if (types.has("string")) return { type: "string", ...(s.description ? { description: s.description } : {}) };
    return null;
  }
  const out: Schema = {};
  for (const k of ["type", "title", "description", "enum", "minLength", "maxLength", "pattern", "minimum", "maximum", "minItems", "maxItems", "default", "format"]) {
    if (s[k] !== undefined) out[k] = s[k];
  }
  if (s.const !== undefined) return null;
  if (s.type === "object") {
    const props: Record<string, Schema> = {};
    for (const [k, v] of Object.entries((s.properties ?? {}) as Record<string, Schema>)) {
      if (JSON_ONLY.has(k)) continue;
      const simple = simplify(v);
      if (simple) props[k] = simple;
    }
    out.properties = props;
    const required = ((s.required ?? []) as string[]).filter((k) => k in props);
    if (required.length) out.required = required;
  }
  if (s.type === "array") {
    const items = simplify((s.items ?? {}) as Schema);
    if (!items) return null;
    out.items = items;
  }
  if (!out.type) return null;
  return out;
}

export interface StepEntry {
  do: string;
  label: string;
  category: StepCategory;
  description: string;
  example: Example;
  /** What a form draws (no `do`). */
  formSchema: Schema;
  /** Fields shown as JSON (messages' components, nested steps), and those edited as text but stored as numbers. */
  jsonFields: string[];
  numberFields: string[];
}

let cached: StepEntry[] | null = null;

/** Every step, in the categories' order. */
export function stepCatalog(): StepEntry[] {
  if (cached) return cached;
  const options = (BlueprintStep as unknown as { options: z.ZodType[] }).options;
  const entries: StepEntry[] = [];
  for (const option of options) {
    const json = z.toJSONSchema(option, { io: "input", unrepresentable: "any" }) as Schema;
    const props = (json.properties ?? {}) as Record<string, Schema>;
    const name = String((props.do as Schema | undefined)?.const ?? "");
    const info = STEP_INFO[name];
    if (!name || !info) continue;
    const { do: _do, ...rest } = props;
    const formSchema = simplify({ ...json, properties: rest, required: ((json.required ?? []) as string[]).filter((k) => k !== "do") }) ?? { type: "object", properties: {} };
    entries.push({
      do: name,
      label: info.label,
      category: info.category,
      description: option.description ?? "",
      example: info.example,
      formSchema,
      jsonFields: Object.keys(rest).filter((k) => JSON_ONLY.has(k)),
      numberFields: Object.entries(rest)
        .filter(([, v]) => isNumberish(v))
        .map(([k]) => k),
    });
  }
  entries.sort((a, b) => STEP_CATEGORIES.indexOf(a.category) - STEP_CATEGORIES.indexOf(b.category));
  cached = entries;
  return entries;
}

// ── "Describe your bot" ─────────────────────────────────────────────────────────────────────────

/** A compact guide to the format for a model: shapes, placeholders, every step with an example. */
export function blueprintGuide(): string {
  const steps = stepCatalog()
    .map((s) => `- ${s.do}: ${s.description} e.g. ${JSON.stringify(s.example)}`)
    .join("\n");
  return `You write kon-dc blueprints: Discord bots as JSON data (never code).

A definition: {"commands": [...], "panels": [...], "modals": [...], "triggers": [...]} (each optional, at least one of commands/panels/triggers).
- command: {"name": "lowercase-name", "description": "...", "options": [{"name","description","type": string|integer|number|boolean|user|role|channel,"required"?,"choices"?:[{"name","value"}]}], "steps": [...]} or "subcommands": [{"name","description","options"?,"steps"}]. "type": "user"|"message" makes a right-click menu (no options, no description). "access": {"roles"?: [ids], "permissions"?: ["manage_guild",...]}; "defaultPermissions": [...].
- panel (a message the bot keeps up to date): {"id","content"?,"embeds"?,"components"?: [[component,...]], "data"?: {"name": "/kon/path"}, "refreshOn"?: ["kon:event"]}.
- component: {"type":"button","id","label","style": primary|secondary|success|danger,"emoji"?,"steps"} | {"type":"select","id","options":[{"label","value"}],"steps"} | {"type":"user_select"|"role_select"|"channel_select","id","steps"} | {"type":"link","label","url"}. A row holds up to 5 buttons or one select; up to 5 rows.
- modal: {"id","title","inputs":[{"id","label","style": short|paragraph,"required"?}],"steps"}; open it with an open_modal step that comes FIRST in its list.
- trigger: {"on": member_join|member_leave|message|reaction_add|kon_event|schedule, "match"?: {"contains"?,"startsWith"?,"channelId"?,"emoji"?}, "event"?: "kon:event", "schedule"?: {"everyMinutes": n} or {"at": "HH:MM","days"?: ["mon",...],"timezone": "UTC"}, "steps"}. Triggers have no reply: use send_message or dm.
- ids (component, modal, panel, saveAs) are lowercase letters, digits, _ and - .
- embeds: {"title"?,"description"?,"color"?: number or "#rrggbb","fields"?: [{"name","value","inline"?}],"footer"?}.
Every step may have "if": {"left","op": eq|neq|contains|starts_with|ends_with|gt|gte|lt|lte|empty|not_empty|in|not_in,"right"?}.

Placeholders in any text: {{user.mention}} {{user.name}} {{user.id}} {{channel.id}} {{option.<name>}} {{value}} {{values}} {{input.<id>}} {{kv.<key>}} {{var.<name>}} {{sent.<saveAs>}} {{call.<saveAs>.<path>}} {{event.<path>}} {{target.id}} {{now.unix}}; filters: {{x|upper}} {{x|number}} {{x|default:text}} {{x|plural:one,many}} {{x|time:R}} {{x|bar:100}}.
The server's economy is shared: currency "coins" (the Economy module) and "xp" (the Levels module).

Steps:
${steps}

Answer with ONE JSON object (the definition) in a \`\`\`json block, nothing else.`;
}

/** The first JSON object in a model's answer (a ```json block, or the outermost braces). */
export function extractJson(text: string): unknown {
  // Found with indexOf, not a regular expression: the model's answer is input (no ReDoS).
  const FENCE = "```";
  let candidate = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const open = text.indexOf(FENCE);
  if (open !== -1) {
    let start = open + FENCE.length;
    if (text.slice(start, start + 4).toLowerCase() === "json") start += 4;
    const close = text.indexOf(FENCE, start);
    if (close !== -1) candidate = text.slice(start, close);
  }
  try {
    return JSON.parse(candidate.trim());
  } catch {
    return null;
  }
}

export type GeneratedDefinition = BlueprintDefinitionInput;
