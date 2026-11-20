/**
 * Bot flows without AI: menus, data capture, branches
 * ============================================================================
 *
 * A flow is data (`koe_flows.definition`), so a supervisor can draw it, an agent can read it and a dry run
 * can say what it would answer. It is a graph of nodes keyed by id:
 *
 *   message   send a text or interactive buttons/list, then `next` (no `next`: the flow ends)
 *   ask       send a question and WAIT; the reply is validated (email, phone, number, regex, one of the
 *             choices) and stored in a variable; a bad answer gets `retryText`, and after `maxRetries`
 *             the flow goes to `onFail` (default: a person)
 *   branch    pick the next node by the reply's button/list id, a keyword in the text, or a condition on
 *             a variable. A branch that looks at the reply WAITS for it; one on variables only decides at once
 *   set       add labels, set the priority, write contact attributes from variables
 *   handoff   ask for a person (optionally a team), with a summary built from the variables
 *   resolve   close the conversation
 *   goto      jump to another node
 *
 *   { "start": "menu", "nodes": {
 *       "menu":  { "type": "message", "interactive": { "type": "buttons", "body": "Hi! What do you need?",
 *                  "buttons": [{ "id": "sales", "title": "Buy" }, { "id": "agent", "title": "A person" }] }, "next": "route" },
 *       "route": { "type": "branch", "cases": [{ "reply": "sales", "next": "email" }, { "reply": "agent", "next": "human" }] },
 *       "email": { "type": "ask", "text": "Your email?", "var": "email", "validate": { "kind": "email" }, "next": "human" },
 *       "human": { "type": "handoff", "summary": "Lead {{vars.email}}" } } }
 *
 * The state of a conversation's flow lives in `koe_conversations.metadata.flow`: {flowId, node, vars,
 * retries, options, lastMessageId}. The bot job is at least once, so a turn is idempotent twice over:
 * every message the flow sends carries an idempotency key derived from the inbound message id
 * (`flow:<messageId>:<n>`), and the state remembers the last message it consumed, so a retried job that
 * already ran answers nothing new.
 *
 * The flow speaks as the bot. The words of a turn that ends handing off or resolving go out as `system`:
 * the delivery job refuses a bot's message once the conversation has left the bot, and "I am passing you to
 * a person" must still arrive.
 *
 * Definitions are checked when saved: unknown node types, targets that do not exist, and loops that
 * never wait for the contact (they would send forever). A turn also stops after 50 steps, whatever.
 *
 * Channels without interactive messages (Messenger and Instagram here) get the same menu as numbered
 * text, and the contact may answer with the number, the title or the id.
 */

import { AppError, asSystem, queue } from "@kitsuden/engine";
import { evaluateCondition, RULE_OPERATORS, type KonContext, type RuleOperator } from "@kitsuden/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "@kitsuden/engine/zod";

import { adapterOf } from "./channels";
import type { Interactive } from "./channels/types";
import { dbOf, emit, isString, newId, QUEUES, type Db } from "./koe.common";
import { autoAssign, changeState } from "./koe.conversations";
import { requireLead, requireMember, USE } from "./koe.policy";
import { koeChannels, koeContacts, koeConversations, koeFlows, koeTeams, type ChannelKind, type Contact, type Conversation, type Message } from "./koe.schema";
import { send } from "./koe.send";
import { resolveValue } from "./koe.templates";
import { Output, ParamId, type OperationsModule } from "./operations";

// ── The language ───────────────────────────────────────────────────────────

export interface FlowOption {
  id: string;
  title: string;
}

export type FlowInteractive =
  | { type: "buttons"; body: string; header?: string; footer?: string; buttons: FlowOption[] }
  | { type: "list"; body: string; header?: string; footer?: string; button: string; sections: Array<{ title?: string; rows: Array<FlowOption & { description?: string }> }> };

export interface AskValidation {
  kind: "text" | "email" | "phone" | "number" | "regex" | "choice";
  pattern?: string;
  choices?: string[];
  min?: number;
  max?: number;
}

export interface BranchCase {
  /** A button or list row id (or, on text channels, its number or title). */
  reply?: string;
  /** Any of these words in the reply. */
  keywords?: string[];
  /** A condition on a variable (`vars.<var>`), with the operators of automation rules. */
  var?: string;
  op?: RuleOperator;
  value?: unknown;
  next: string;
}

export type MessageNode = { type: "message"; text?: string; interactive?: FlowInteractive; next?: string };
export type AskNode = { type: "ask"; text?: string; interactive?: FlowInteractive; var: string; validate?: AskValidation; retryText?: string; maxRetries?: number; next: string; onFail?: string };
export type BranchNode = { type: "branch"; cases: BranchCase[]; default?: string; retryText?: string; maxRetries?: number; onFail?: string };
export type SetNode = {
  type: "set";
  labels?: string[];
  priority?: "low" | "normal" | "high" | "urgent";
  /** Contact attribute → value, with `{{vars.x}}` placeholders. */
  attributes?: Record<string, string>;
  /** The contact's own fields, from variables. */
  contact?: { displayName?: string; email?: string; phone?: string };
  next?: string;
};
export type HandoffNode = { type: "handoff"; teamId?: string; text?: string; summary?: string; reason?: string };
export type ResolveNode = { type: "resolve"; text?: string };
export type GotoNode = { type: "goto"; next: string };
export type FlowNode = MessageNode | AskNode | BranchNode | SetNode | HandoffNode | ResolveNode | GotoNode;

export interface FlowDefinition {
  start: string;
  nodes: Record<string, FlowNode>;
}

export type TurnOutcome = "waiting" | "ended" | "handoff" | "resolved";

export interface FlowState {
  flowId: string;
  /** The node waiting for the contact's answer; null when the flow is not in the middle of something. */
  node: string | null;
  vars: Record<string, string>;
  retries: number;
  /** The options of the last interactive message (to read "2" or a title on text channels). */
  options?: FlowOption[];
  /** The last inbound message this flow consumed: a retried job does nothing twice. */
  lastMessageId?: string;
  outcome?: TurnOutcome;
}

export interface Reply {
  id?: string | null;
  text: string;
}

export type Say = { kind: "text"; body: string } | { kind: "interactive"; interactive: Interactive };

export interface FlowEffects {
  say(out: Say): Promise<void>;
  set(node: SetNode, vars: Record<string, string>): Promise<void>;
  handoff(node: HandoffNode, vars: Record<string, string>): Promise<void>;
  resolve(): Promise<void>;
  /** Fills `{{vars.x}}` and `{{contact.name}}`. */
  render(text: string, vars: Record<string, string>): string;
}

const NODE_TYPES = ["message", "ask", "branch", "set", "handoff", "resolve", "goto"] as const;
const NODE_ID = /^[A-Za-z0-9_-]{1,60}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const MAX_NODES = 200;
const MAX_STEPS = 50;
const DEFAULT_RETRIES = 2;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Words without case or accents: "Sí, Ventas!" → "si ventas". */
export function normalize(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@.+_-]+/gu, " ")
    .trim();
}

function optionsOf(interactive: FlowInteractive | undefined): FlowOption[] {
  if (!interactive) return [];
  if (interactive.type === "buttons") return interactive.buttons.map((b) => ({ id: b.id, title: b.title }));
  return interactive.sections.flatMap((s) => s.rows.map((r) => ({ id: r.id, title: r.title })));
}

/** Which option the reply picked: its id (a tap), its number or its title (typed). */
export function choiceOf(reply: Reply, options: FlowOption[]): string | null {
  if (reply.id && options.some((o) => o.id === reply.id)) return reply.id;
  const t = normalize(reply.text);
  if (!t) return null;
  if (/^\d{1,2}$/.test(t)) {
    const o = options[Number(t) - 1];
    if (o) return o.id;
  }
  const hit = options.find((o) => normalize(o.title) === t || normalize(o.id) === t);
  return hit?.id ?? null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/** Checks an answer to an `ask`. The value stored is trimmed (a choice stores the option id). */
export function validateAnswer(node: AskNode, reply: Reply, options: FlowOption[]): { ok: true; value: string } | { ok: false } {
  const text = reply.text.trim();
  const v = node.validate ?? { kind: "text" };
  switch (v.kind) {
    case "email":
      return EMAIL.test(text) ? { ok: true, value: text.toLowerCase() } : { ok: false };
    case "phone": {
      const digits = text.replace(/[\s().-]/g, "");
      return /^\+?\d{6,15}$/.test(digits) ? { ok: true, value: digits } : { ok: false };
    }
    case "number": {
      const n = Number(text.replace(",", "."));
      if (!text || !Number.isFinite(n)) return { ok: false };
      if (v.min !== undefined && n < v.min) return { ok: false };
      if (v.max !== undefined && n > v.max) return { ok: false };
      return { ok: true, value: String(n) };
    }
    case "regex": {
      try {
        return text.length <= 1000 && new RegExp(v.pattern ?? ".*", "u").test(text) ? { ok: true, value: text } : { ok: false };
      } catch {
        return { ok: false };
      }
    }
    case "choice": {
      const pool = v.choices?.length ? (options.length ? options.filter((o) => v.choices!.includes(o.id)) : v.choices.map((c) => ({ id: c, title: c }))) : options;
      const id = choiceOf(reply, pool);
      return id ? { ok: true, value: id } : { ok: false };
    }
    default:
      return text ? { ok: true, value: text.slice(0, 1000) } : { ok: false };
  }
}

const needsInput = (node: FlowNode): boolean => node.type === "ask" || (node.type === "branch" && node.cases.some((c) => c.reply !== undefined || c.keywords !== undefined));

function caseMatches(c: BranchCase, reply: Reply | null, state: FlowState): boolean {
  if (c.reply !== undefined) {
    if (!reply) return false;
    const picked = state.options?.length ? choiceOf(reply, state.options) : (reply.id ?? null);
    if (picked !== c.reply && normalize(reply.text) !== normalize(c.reply)) return false;
  }
  if (c.keywords !== undefined) {
    if (!reply) return false;
    const padded = ` ${normalize(reply.text)} `;
    if (!c.keywords.some((k) => normalize(k) && padded.includes(` ${normalize(k)} `))) return false;
  }
  if (c.var !== undefined) {
    if (!evaluateCondition({ field: `vars.${c.var}`, op: c.op ?? "exists", value: c.value }, { vars: state.vars })) return false;
  }
  return true;
}

/** Interactive as numbered text, for channels that cannot show buttons. */
export function asText(i: FlowInteractive): string {
  const lines = [i.header, i.body].filter(isString);
  optionsOf(i).forEach((o, n) => lines.push(`${n + 1}. ${o.title}`));
  if (i.footer) lines.push(i.footer);
  return lines.join("\n");
}

type Step = { state: FlowState; outcome: TurnOutcome };

/**
 * Runs the flow from `state` until it must wait for the contact, or it ends. `reply` is the answer to the
 * node the state waits at; null when the flow starts (the first message only wakes it).
 */
export async function advance(def: FlowDefinition, start: FlowState, reply: Reply | null, fx: FlowEffects, opts: { interactive: boolean }): Promise<Step> {
  const s: FlowState = { ...start, vars: { ...start.vars }, options: start.options ? [...start.options] : undefined };
  const resuming = !!s.node && !!def.nodes[s.node];
  let nodeId = resuming ? s.node! : def.start;
  let input = resuming ? reply : null;

  const say = async (text: string | undefined, interactive?: FlowInteractive) => {
    if (interactive) {
      const filled = { ...interactive, body: fx.render(interactive.body, s.vars) } as FlowInteractive;
      s.options = optionsOf(filled);
      if (opts.interactive) await fx.say({ kind: "interactive", interactive: filled as Interactive });
      else await fx.say({ kind: "text", body: asText(filled) });
    }
    if (text) await fx.say({ kind: "text", body: fx.render(text, s.vars) });
  };
  const handoff = async (node: HandoffNode): Promise<Step> => {
    if (node.text) await say(node.text);
    await fx.handoff(node, s.vars);
    s.node = null;
    s.retries = 0;
    return { state: s, outcome: "handoff" };
  };
  const failed = async (node: AskNode | BranchNode, current: string): Promise<{ next: string } | { done: Step }> => {
    s.retries += 1;
    if (s.retries > (node.maxRetries ?? DEFAULT_RETRIES)) {
      s.retries = 0;
      if (node.onFail) return { next: node.onFail };
      return { done: await handoff({ type: "handoff", reason: "the contact could not answer the bot" }) };
    }
    const kind = node.type === "ask" ? node.validate?.kind : undefined;
    const fallback = kind && kind !== "text" ? `That does not look like a valid ${kind === "choice" ? "option" : kind}. Please try again.` : "Sorry, I did not understand. Please choose one of the options.";
    await say(node.retryText ?? fallback);
    s.node = current;
    return { done: { state: s, outcome: "waiting" } };
  };

  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const node = def.nodes[nodeId];
    if (!node) {
      s.node = null;
      return { state: s, outcome: "ended" };
    }
    switch (node.type) {
      case "message":
        await say(node.text, node.interactive);
        if (!node.next) {
          s.node = null;
          return { state: s, outcome: "ended" };
        }
        nodeId = node.next;
        break;
      case "ask": {
        if (input === null) {
          if (!node.interactive) s.options = node.validate?.kind === "choice" ? s.options : undefined;
          await say(node.text, node.interactive);
          s.node = nodeId;
          s.retries = 0;
          return { state: s, outcome: "waiting" };
        }
        const answer = validateAnswer(node, input, s.options ?? optionsOf(node.interactive));
        input = null;
        if (answer.ok) {
          s.vars[node.var] = answer.value;
          s.retries = 0;
          nodeId = node.next;
          break;
        }
        const r = await failed(node, nodeId);
        if ("done" in r) return r.done;
        nodeId = r.next;
        break;
      }
      case "branch": {
        if (needsInput(node) && input === null) {
          s.node = nodeId;
          s.retries = 0;
          return { state: s, outcome: "waiting" };
        }
        const hit = node.cases.find((c) => caseMatches(c, input, s));
        input = null;
        if (hit || node.default) {
          s.retries = 0;
          nodeId = hit ? hit.next : node.default!;
          break;
        }
        const r = await failed(node, nodeId);
        if ("done" in r) return r.done;
        nodeId = r.next;
        break;
      }
      case "set":
        await fx.set(node, s.vars);
        if (!node.next) {
          s.node = null;
          return { state: s, outcome: "ended" };
        }
        nodeId = node.next;
        break;
      case "handoff":
        return handoff(node);
      case "resolve":
        if (node.text) await say(node.text);
        await fx.resolve();
        s.node = null;
        return { state: s, outcome: "resolved" };
      case "goto":
        nodeId = node.next;
        break;
    }
  }
  // Only a definition saved before the loop check could get here.
  return handoff({ type: "handoff", reason: "the flow went in circles" });
}

// ── Checking a definition ──────────────────────────────────────────────────

function interactiveProblems(at: string, i: unknown): string[] {
  const out: string[] = [];
  if (!isObj(i)) return [`${at}: interactive must be an object`];
  if (!isString(i.body) || i.body.length > 1024) out.push(`${at}: interactive.body is required (up to 1024 characters)`);
  if (i.type === "buttons") {
    const b = i.buttons;
    if (!Array.isArray(b) || b.length < 1 || b.length > 3) return [...out, `${at}: buttons takes 1 to 3 buttons`];
    const ids = new Set<string>();
    for (const btn of b as unknown[]) {
      if (!isObj(btn) || !isString(btn.id) || btn.id.length > 256 || !isString(btn.title) || btn.title.length > 20) out.push(`${at}: each button needs an id and a title of up to 20 characters`);
      else if (ids.has(btn.id)) out.push(`${at}: button id "${btn.id}" is used twice`);
      else ids.add(btn.id);
    }
  } else if (i.type === "list") {
    if (!isString(i.button) || i.button.length > 20) out.push(`${at}: list.button is required (up to 20 characters)`);
    const sections = Array.isArray(i.sections) ? (i.sections as unknown[]) : [];
    const rows = sections.flatMap((s) => (isObj(s) && Array.isArray(s.rows) ? (s.rows as unknown[]) : []));
    if (rows.length < 1 || rows.length > 10) out.push(`${at}: a list takes 1 to 10 rows in total`);
    const ids = new Set<string>();
    for (const r of rows) {
      if (!isObj(r) || !isString(r.id) || r.id.length > 200 || !isString(r.title) || r.title.length > 24) out.push(`${at}: each row needs an id and a title of up to 24 characters`);
      else if (ids.has(r.id)) out.push(`${at}: row id "${r.id}" is used twice`);
      else ids.add(r.id);
    }
  } else {
    out.push(`${at}: interactive.type must be "buttons" or "list"`);
  }
  return out;
}

const textOk = (v: unknown, max = 4096) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= max);

function edgesOf(n: FlowNode): string[] {
  switch (n.type) {
    case "message":
    case "set":
      return n.next ? [n.next] : [];
    case "goto":
      return [n.next];
    case "ask":
      return [n.next, ...(n.onFail ? [n.onFail] : [])];
    case "branch":
      return [...n.cases.map((c) => c.next), ...(n.default ? [n.default] : []), ...(n.onFail ? [n.onFail] : [])];
    default:
      return [];
  }
}

/** What is wrong with a definition (empty: it can be saved), and what is merely odd. */
export function checkFlow(raw: unknown): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!isObj(raw)) return { problems: ["the definition must be an object"], warnings };
  const nodes = raw.nodes;
  if (!isObj(nodes)) return { problems: ["nodes must be an object keyed by node id"], warnings };
  const ids = Object.keys(nodes);
  if (ids.length === 0) problems.push("a flow needs at least one node");
  if (ids.length > MAX_NODES) problems.push(`a flow takes at most ${MAX_NODES} nodes`);
  if (!isString(raw.start) || !Object.prototype.hasOwnProperty.call(nodes, raw.start)) problems.push("start must name one of the nodes");
  const target = (at: string, field: string, v: unknown, required: boolean) => {
    if (v === undefined) {
      if (required) problems.push(`${at}: ${field} is required`);
      return;
    }
    if (!isString(v) || !Object.prototype.hasOwnProperty.call(nodes, v)) problems.push(`${at}: ${field} "${String(v)}" is not a node`);
  };

  for (const id of ids) {
    const at = `node "${id}"`;
    if (!NODE_ID.test(id)) problems.push(`${at}: ids are letters, digits, "-" and "_" (up to 60)`);
    const n = nodes[id];
    if (!isObj(n)) {
      problems.push(`${at} is not an object`);
      continue;
    }
    if (!NODE_TYPES.includes(n.type as (typeof NODE_TYPES)[number])) {
      problems.push(`${at}: unknown type "${String(n.type)}" (${NODE_TYPES.join(", ")})`);
      continue;
    }
    if (!textOk(n.text)) problems.push(`${at}: text must be 1 to 4096 characters`);
    switch (n.type) {
      case "message":
        if (n.text === undefined && n.interactive === undefined) problems.push(`${at}: a message needs text or interactive`);
        if (n.interactive !== undefined) problems.push(...interactiveProblems(at, n.interactive));
        target(at, "next", n.next, false);
        break;
      case "ask": {
        if (!isString(n.var) || !VAR_NAME.test(n.var)) problems.push(`${at}: var must be a name such as "email"`);
        if (n.text === undefined && n.interactive === undefined) problems.push(`${at}: an ask needs the question (text or interactive)`);
        if (n.interactive !== undefined) problems.push(...interactiveProblems(at, n.interactive));
        if (!textOk(n.retryText, 1024)) problems.push(`${at}: retryText must be 1 to 1024 characters`);
        if (n.maxRetries !== undefined && (!Number.isInteger(n.maxRetries) || (n.maxRetries as number) < 0 || (n.maxRetries as number) > 10)) problems.push(`${at}: maxRetries goes from 0 to 10`);
        const v = n.validate;
        if (v !== undefined) {
          if (!isObj(v) || !["text", "email", "phone", "number", "regex", "choice"].includes(String(v.kind))) problems.push(`${at}: validate.kind must be text, email, phone, number, regex or choice`);
          else if (v.kind === "regex") {
            if (!isString(v.pattern) || v.pattern.length > 200) problems.push(`${at}: a regex needs a pattern of up to 200 characters`);
            else {
              try {
                new RegExp(v.pattern, "u");
              } catch {
                problems.push(`${at}: the pattern is not a valid regular expression`);
              }
            }
          } else if (v.kind === "choice") {
            if (!isObj(n.interactive) && (!Array.isArray(v.choices) || v.choices.length === 0 || !v.choices.every(isString))) problems.push(`${at}: a choice needs interactive options or a list of choices`);
          } else if (v.kind === "number") {
            for (const k of ["min", "max"] as const) if (v[k] !== undefined && typeof v[k] !== "number") problems.push(`${at}: validate.${k} must be a number`);
          }
        }
        target(at, "next", n.next, true);
        target(at, "onFail", n.onFail, false);
        break;
      }
      case "branch": {
        const cases = n.cases;
        if (!Array.isArray(cases) || cases.length < 1 || cases.length > 20) {
          problems.push(`${at}: a branch takes 1 to 20 cases`);
          break;
        }
        let onVarsOnly = true;
        cases.forEach((c: unknown, i: number) => {
          const cat = `${at} case ${i + 1}`;
          if (!isObj(c)) {
            problems.push(`${cat} is not an object`);
            return;
          }
          if (c.reply === undefined && c.keywords === undefined && c.var === undefined) problems.push(`${cat}: give reply, keywords or var`);
          if (c.reply !== undefined && !isString(c.reply)) problems.push(`${cat}: reply must be an option id`);
          if (c.keywords !== undefined && (!Array.isArray(c.keywords) || c.keywords.length === 0 || c.keywords.length > 30 || !c.keywords.every((k) => isString(k) && k.length <= 60))) problems.push(`${cat}: keywords must be 1 to 30 words`);
          if (c.var !== undefined && (!isString(c.var) || !VAR_NAME.test(c.var))) problems.push(`${cat}: var must be a variable name`);
          if (c.op !== undefined && !RULE_OPERATORS.includes(c.op as RuleOperator)) problems.push(`${cat}: op must be one of ${RULE_OPERATORS.join(", ")}`);
          if (c.op === "in" && !Array.isArray(c.value)) problems.push(`${cat}: "in" needs a list as value`);
          if (c.reply !== undefined || c.keywords !== undefined) onVarsOnly = false;
          target(cat, "next", c.next, true);
        });
        if (onVarsOnly && n.default === undefined) problems.push(`${at}: a branch on variables only needs a default`);
        target(at, "default", n.default, false);
        target(at, "onFail", n.onFail, false);
        if (!textOk(n.retryText, 1024)) problems.push(`${at}: retryText must be 1 to 1024 characters`);
        if (n.maxRetries !== undefined && (!Number.isInteger(n.maxRetries) || (n.maxRetries as number) < 0 || (n.maxRetries as number) > 10)) problems.push(`${at}: maxRetries goes from 0 to 10`);
        break;
      }
      case "set": {
        if (n.labels !== undefined && (!Array.isArray(n.labels) || n.labels.length > 10 || !n.labels.every((l) => isString(l) && l.length <= 60))) problems.push(`${at}: labels must be up to 10 texts of up to 60 characters`);
        if (n.priority !== undefined && !["low", "normal", "high", "urgent"].includes(String(n.priority))) problems.push(`${at}: priority must be low, normal, high or urgent`);
        if (n.attributes !== undefined && (!isObj(n.attributes) || Object.keys(n.attributes).length > 30 || !Object.entries(n.attributes).every(([k, v]) => VAR_NAME.test(k) && typeof v === "string" && v.length <= 500))) problems.push(`${at}: attributes maps names to texts`);
        if (n.contact !== undefined && (!isObj(n.contact) || !Object.entries(n.contact).every(([k, v]) => ["displayName", "email", "phone"].includes(k) && typeof v === "string" && v.length <= 300))) problems.push(`${at}: contact takes displayName, email and phone`);
        if (n.labels === undefined && n.priority === undefined && n.attributes === undefined && n.contact === undefined) warnings.push(`${at} sets nothing`);
        target(at, "next", n.next, false);
        break;
      }
      case "handoff":
        if (n.teamId !== undefined && !isString(n.teamId)) problems.push(`${at}: teamId must be a team id`);
        if (!textOk(n.summary, 2000)) problems.push(`${at}: summary must be 1 to 2000 characters`);
        break;
      case "resolve":
        break;
      case "goto":
        target(at, "next", n.next, true);
        break;
    }
  }
  if (problems.length) return { problems, warnings };

  const def = raw as unknown as FlowDefinition;
  // Loops that never wait for the contact: a cycle made only of nodes that do not need input.
  const color = new Map<string, 1 | 2>();
  let loop: string[] = [];
  const visit = (id: string, path: string[]): boolean => {
    color.set(id, 1);
    for (const next of edgesOf(def.nodes[id]!)) {
      if (needsInput(def.nodes[next]!)) continue;
      const c = color.get(next);
      if (c === 1) {
        loop = [...path.slice(path.indexOf(next)), id, next];
        return true;
      }
      if (c === undefined && visit(next, [...path, id])) return true;
    }
    color.set(id, 2);
    return false;
  };
  for (const id of ids) {
    if (needsInput(def.nodes[id]!) || color.has(id)) continue;
    if (visit(id, [])) {
      problems.push(`the nodes ${loop.map((x) => `"${x}"`).join(" → ")} loop without waiting for the contact`);
      break;
    }
  }
  // Unreachable nodes are allowed (a draft), but worth saying.
  const seen = new Set<string>();
  const stack = [def.start];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...edgesOf(def.nodes[id]!));
  }
  for (const id of ids) if (!seen.has(id)) warnings.push(`node "${id}" cannot be reached from start`);
  return { problems, warnings };
}

// ── Running a turn ─────────────────────────────────────────────────────────

type FlowRow = typeof koeFlows.$inferSelect;

async function flowFor(db: Db, conversation: Conversation, savedFlowId: string | undefined): Promise<FlowRow | null> {
  const [channel] = (await db.select({ settings: koeChannels.settings }).from(koeChannels).where(eq(koeChannels.id, conversation.channelId)).limit(1)) as Array<{ settings: { flowId?: string } | null }>;
  for (const id of [savedFlowId, channel?.settings?.flowId]) {
    if (!id) continue;
    const [f] = (await db.select().from(koeFlows).where(and(eq(koeFlows.id, id), eq(koeFlows.active, true))).limit(1)) as FlowRow[];
    if (f) return f;
  }
  const [own] = (await db
    .select()
    .from(koeFlows)
    .where(and(eq(koeFlows.channelId, conversation.channelId), eq(koeFlows.active, true)))
    .orderBy(desc(koeFlows.updatedAt))
    .limit(1)) as FlowRow[];
  return own ?? null;
}

function replyOf(message: Message): Reply {
  const p = (message.payload ?? {}) as Record<string, unknown>;
  return { id: typeof p.id === "string" ? p.id : null, text: message.body ?? "" };
}

function renderer(contact: Partial<Contact> | null) {
  return (text: string, vars: Record<string, string>) => {
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) extra[`vars.${k}`] = v;
    return resolveValue(text, contact, extra);
  };
}

/** The default summary for a person: what the flow learned. */
function summaryOf(flowName: string, vars: Record<string, string>): string {
  const pairs = Object.entries(vars).map(([k, v]) => `${k}: ${v}`);
  return `Flow "${flowName}"${pairs.length ? ` — ${pairs.join(", ")}` : ""}`.slice(0, 2000);
}

/** Labels, priority and contact fields from a `set` node (also used by the automation steps). */
export async function applySet(ctx: KonContext, db: Db, conversationId: string, node: Pick<SetNode, "labels" | "priority" | "attributes" | "contact">, render: (t: string) => string, by: string): Promise<void> {
  const [conv] = (await db.select().from(koeConversations).where(eq(koeConversations.id, conversationId)).limit(1)) as Conversation[];
  if (!conv) return;
  const patch: Record<string, unknown> = {};
  if (node.labels?.length) {
    const labels = [...new Set([...(conv.labels ?? []), ...node.labels.map((l) => render(l).trim()).filter(Boolean)])].slice(0, 50);
    if (labels.length !== (conv.labels ?? []).length) {
      patch.labels = labels;
      emit(ctx, "conversation.labeled", { conversationId, labels, by });
    }
  }
  if (node.priority) patch.priority = node.priority;
  if (Object.keys(patch).length) await db.update(koeConversations).set({ ...patch, updatedAt: new Date() }).where(eq(koeConversations.id, conversationId));

  const attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.attributes ?? {})) {
    const value = render(v).trim();
    if (value) attributes[k] = value.slice(0, 500);
  }
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(node.contact ?? {})) {
    const value = render(v ?? "").trim();
    if (!value) continue;
    if (k === "email" && !EMAIL.test(value)) continue;
    if (k === "phone" && !/^\+?\d{6,15}$/.test(value.replace(/[\s().-]/g, ""))) continue;
    fields[k] = k === "phone" ? value.replace(/[^\d]/g, "") : value.slice(0, 300);
  }
  if (Object.keys(attributes).length || Object.keys(fields).length) {
    await db
      .update(koeContacts)
      .set({ ...fields, ...(Object.keys(attributes).length ? { attributes: sql`${koeContacts.attributes} || ${JSON.stringify(attributes)}::jsonb` } : {}), updatedAt: new Date() })
      .where(eq(koeContacts.id, conv.contactId));
    emit(ctx, "contact.updated", { contactId: conv.contactId, by });
  }
}

/** A conversation asks for a person: the queue, a summary, automatic assignment and the notice. */
export async function handOff(
  ctx: KonContext,
  db: Db,
  conversationId: string,
  opts: { teamId?: string | null; reason: string; summary?: string | null },
  actor: { kind: "bot" | "rule" | "system"; id?: string | null }
): Promise<Conversation> {
  let teamId: string | undefined;
  if (opts.teamId) {
    const [team] = (await db.select({ id: koeTeams.id }).from(koeTeams).where(eq(koeTeams.id, opts.teamId)).limit(1)) as Array<{ id: string }>;
    if (team) teamId = team.id;
  }
  if (opts.summary) await db.update(koeConversations).set({ metadata: sql`${koeConversations.metadata} || ${JSON.stringify({ handoffSummary: opts.summary })}::jsonb` }).where(eq(koeConversations.id, conversationId));
  let conv = await changeState(ctx, db, conversationId, { trigger: "handoff", reason: opts.reason, ...(teamId ? { teamId } : {}) }, actor);
  conv = await autoAssign(ctx, db, conv);
  if (conv.state === "queued") {
    await queue.dispatch(QUEUES.notify, "queued", { teamId: conv.teamId, conversationId: conv.id }, { attempts: 3 });
  } else if (conv.state === "human" && conv.assigneeId) {
    await queue.dispatch(QUEUES.notify, "user", { userId: conv.assigneeId, kind: "assigned", title: "A conversation was handed to you", body: opts.summary ?? null, conversationId: conv.id }, { attempts: 3 });
  }
  return conv;
}

async function saveState(db: Db, conversationId: string, state: FlowState): Promise<void> {
  await db
    .update(koeConversations)
    .set({ metadata: sql`${koeConversations.metadata} || ${JSON.stringify({ flow: state })}::jsonb` })
    .where(eq(koeConversations.id, conversationId));
}

/**
 * Runs one turn of the channel's flow for an inbound message.
 *   "handled"  the flow answered (or waits for the next answer)
 *   "handoff"  the flow asked for a person (the conversation is already queued, or assigned, and notified)
 *   "no-flow"  there is no active flow: the caller decides (AI bot, or the queue)
 */
export async function runFlowTurn(ctx: KonContext, db: Db, conversation: Conversation, message: Message): Promise<"handled" | "handoff" | "no-flow"> {
  return asSystem(async () => {
    const [fresh] = (await db.select().from(koeConversations).where(eq(koeConversations.id, conversation.id)).limit(1)) as Conversation[];
    if (!fresh) return "no-flow";
    const saved = (fresh.metadata?.flow ?? undefined) as FlowState | undefined;
    if (saved?.lastMessageId === message.id) return saved.outcome === "handoff" ? "handoff" : "handled";
    if (fresh.state !== "bot") return "no-flow";
    const flow = await flowFor(db, fresh, saved?.flowId);
    if (!flow) return "no-flow";
    const def = flow.definition as unknown as FlowDefinition;
    if (checkFlow(def).problems.length) {
      ctx.logger.warn("koe: a stored flow is invalid; skipped", { flowId: flow.id });
      return "no-flow";
    }

    const [channel] = (await db.select({ kind: koeChannels.kind }).from(koeChannels).where(eq(koeChannels.id, fresh.channelId)).limit(1)) as Array<{ kind: ChannelKind }>;
    const [contact] = (await db.select().from(koeContacts).where(eq(koeContacts.id, fresh.contactId)).limit(1)) as Contact[];
    const resume = !!saved && saved.flowId === flow.id && !!saved.node && !!def.nodes[saved.node];
    const state: FlowState = resume ? saved! : { flowId: flow.id, node: null, vars: saved?.flowId === flow.id ? (saved.vars ?? {}) : {}, retries: 0 };
    const render = renderer(contact ?? null);
    // What the turn says and the change of state it ends with are applied after it ran: the delivery refuses a
    // bot's message once the conversation left the bot, so the words of a turn that hands off or resolves
    // ("I'm passing you to a person") go out as the system, before the state changes.
    const said: Say[] = [];
    let finish: (() => Promise<unknown>) | null = null;
    const fx: FlowEffects = {
      render,
      say: async (out) => void said.push(out),
      set: (node, vars) => applySet(ctx, db, fresh.id, node, (t) => render(t, vars), "bot"),
      handoff: async (node, vars) => {
        finish = () => handOff(ctx, db, fresh.id, { teamId: node.teamId, reason: node.reason ?? `flow ${flow.name}`, summary: node.summary ? render(node.summary, vars) : summaryOf(flow.name, vars) }, { kind: "bot" });
      },
      resolve: async () => {
        finish = () => changeState(ctx, db, fresh.id, { trigger: "bot_resolved", reason: `flow ${flow.name}` }, { kind: "bot" });
      },
    };
    const { state: next, outcome } = await advance(def, state, resume ? replyOf(message) : null, fx, { interactive: adapterOf(channel?.kind ?? "webchat").capabilities.interactive });
    const author = { kind: outcome === "handoff" || outcome === "resolved" ? ("system" as const) : ("bot" as const) };
    for (const [n, out] of said.entries()) {
      const idempotencyKey = `flow:${message.id}:${n}`;
      await send(
        { ctx, db },
        out.kind === "text"
          ? { conversationId: fresh.id, author, kind: "text", body: out.body, idempotencyKey }
          : { conversationId: fresh.id, author, kind: "interactive", interactive: out.interactive, body: out.interactive.body, idempotencyKey }
      );
    }
    if (finish) await (finish as () => Promise<unknown>)();
    await saveState(db, fresh.id, { ...next, lastMessageId: message.id, outcome });
    if (outcome !== "waiting") emit(ctx, "flow.completed", { conversationId: fresh.id, channelId: fresh.channelId, flowId: flow.id, outcome, vars: next.vars });
    return outcome === "handoff" ? "handoff" : "handled";
  });
}

// ── Dry run ────────────────────────────────────────────────────────────────

export type TranscriptLine =
  | { from: "contact"; text: string; id?: string | null }
  | { from: "bot"; text?: string; interactive?: unknown }
  | { action: "set"; labels?: string[]; priority?: string; attributes?: Record<string, string>; contact?: Record<string, string> }
  | { action: "handoff"; teamId: string | null; summary: string }
  | { action: "resolve" };

/** Plays a flow against a list of replies, touching nothing. The first reply only starts it, as in a real chat. */
export async function simulateFlow(
  def: FlowDefinition,
  replies: Array<string | { id: string; title?: string }>,
  opts: { interactive: boolean; name?: string }
): Promise<{ transcript: TranscriptLine[]; state: FlowState; outcome: TurnOutcome }> {
  const transcript: TranscriptLine[] = [];
  const render = renderer({ displayName: "Test contact", phone: "15550000000", email: null, attributes: {} });
  const fill = (o: Record<string, string> | undefined, vars: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, render(v, vars)])) : undefined);
  const fx: FlowEffects = {
    render,
    say: async (out) => void transcript.push(out.kind === "text" ? { from: "bot", text: out.body } : { from: "bot", interactive: out.interactive }),
    set: async (node, vars) => void transcript.push({ action: "set", labels: node.labels, priority: node.priority, attributes: fill(node.attributes, vars), contact: fill(node.contact as Record<string, string> | undefined, vars) }),
    handoff: async (node, vars) => void transcript.push({ action: "handoff", teamId: node.teamId ?? null, summary: node.summary ? render(node.summary, vars) : summaryOf(opts.name ?? "test", vars) }),
    resolve: async () => void transcript.push({ action: "resolve" }),
  };
  let state: FlowState = { flowId: "test", node: null, vars: {}, retries: 0 };
  let outcome: TurnOutcome = "ended";
  for (const raw of replies.length ? replies : ["hi"]) {
    const reply: Reply = typeof raw === "string" ? { text: raw } : { id: raw.id, text: raw.title ?? raw.id };
    transcript.push({ from: "contact", text: reply.text, id: reply.id ?? null });
    const r = await advance(def, state, state.node ? reply : null, fx, opts);
    state = r.state;
    outcome = r.outcome;
    if (outcome === "handoff" || outcome === "resolved") break;
  }
  return { transcript, state, outcome };
}

// ── Operations ─────────────────────────────────────────────────────────────

const Definition = z
  .object({ start: z.string().min(1).max(60), nodes: z.record(z.string(), z.unknown()) })
  .passthrough()
  .describe("The flow: { start, nodes: { <id>: { type: message | ask | branch | set | handoff | resolve | goto, … } } }");
const FlowFields = z.object({
  name: z.string().trim().min(1).max(200),
  channelId: z.string().min(1).max(100).nullable().optional().describe("The channel whose bot runs it (or set the channel's settings.flowId)"),
  definition: Definition,
  active: z.boolean().optional(),
});

async function checkOrThrow(db: Db, def: unknown): Promise<string[]> {
  const { problems, warnings } = checkFlow(def);
  // Teams named by handoff nodes must exist.
  if (!problems.length) {
    const teams = Object.values((def as FlowDefinition).nodes).flatMap((n) => (n.type === "handoff" && n.teamId ? [n.teamId] : []));
    for (const t of new Set(teams)) {
      const [row] = (await db.select({ id: koeTeams.id }).from(koeTeams).where(eq(koeTeams.id, t)).limit(1)) as unknown[];
      if (!row) problems.push(`team "${t}" does not exist`);
    }
  }
  if (problems.length) throw AppError.validation(`The flow cannot be saved: ${problems.join("; ")}`, { koe: "FLOW_INVALID", problems });
  return warnings;
}

export const flowOperations: OperationsModule = (app, ctx) => {
  const db = (): Db => dbOf(ctx);

  app.get(
    "/flows",
    {
      id: "list-flows",
      summary: "List bot flows",
      description: "The bot flows without AI (menus, data capture, branches) and which channel runs each.",
      access: "session",
      permission: USE,
      unpaginated: "The bot flows leads wrote by hand: configuration, a few per channel.",
      output: { schema: Output },
    },
    async (c, _i, h) => {
      await requireMember(db(), h.user);
      const rows = (await db().select().from(koeFlows).orderBy(desc(koeFlows.updatedAt))) as FlowRow[];
      return c.json({ data: rows.map((f) => ({ id: f.id, name: f.name, channelId: f.channelId, active: f.active, nodes: Object.keys((f.definition as { nodes?: object }).nodes ?? {}).length, updatedAt: f.updatedAt })) });
    }
  );

  app.get(
    "/flows/:id",
    {
      id: "get-flow",
      summary: "Get a bot flow",
      description: "A flow with its full definition and what its check says about it.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [f] = (await db().select().from(koeFlows).where(eq(koeFlows.id, input.params.id)).limit(1)) as FlowRow[];
      if (!f) throw AppError.notFound("Flow not found");
      return c.json({ data: { ...f, check: checkFlow(f.definition) } });
    }
  );

  app.post(
    "/flows",
    {
      id: "create-flow",
      summary: "Create a bot flow",
      description: "Saves a flow after checking it: unknown node types, targets that do not exist and loops that never wait for the contact are refused (422 with `problems`). Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { body: FlowFields },
      output: { schema: Output, status: 201 },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const warnings = await checkOrThrow(db(), input.body.definition);
      const now = new Date();
      const [row] = (await db()
        .insert(koeFlows)
        .values({ id: newId(), name: input.body.name, channelId: input.body.channelId ?? null, definition: input.body.definition, active: input.body.active ?? true, createdAt: now, updatedAt: now })
        .returning()) as unknown[];
      return c.json({ data: row, warnings }, 201);
    }
  );

  app.patch(
    "/flows/:id",
    {
      id: "update-flow",
      summary: "Change a bot flow",
      description: "Name, channel, definition (checked again) or whether it is active. Conversations in the middle of it continue from their node when it still exists. Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { params: ParamId, body: FlowFields.partial() },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const warnings = input.body.definition ? await checkOrThrow(db(), input.body.definition) : [];
      const [row] = (await db()
        .update(koeFlows)
        .set({ ...input.body, updatedAt: new Date() })
        .where(eq(koeFlows.id, input.params.id))
        .returning()) as unknown[];
      if (!row) throw AppError.notFound("Flow not found");
      return c.json({ data: row, warnings });
    }
  );

  app.delete(
    "/flows/:id",
    {
      id: "delete-flow",
      summary: "Delete a bot flow",
      description: "Deletes the flow. Channels that named it fall back to their AI bot or the queue. Supervisors and admins.",
      access: "session",
      permission: USE,
      input: { params: ParamId },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireLead(db(), h.user);
      const rows = (await db().delete(koeFlows).where(eq(koeFlows.id, input.params.id)).returning({ id: koeFlows.id })) as unknown[];
      if (!rows.length) throw AppError.notFound("Flow not found");
      return c.json({ data: { ok: true } });
    }
  );

  app.post(
    "/flows/:id/test",
    {
      id: "test-flow",
      summary: "Try a bot flow",
      description:
        "Plays the flow against a list of replies and returns the transcript (what the bot would send, the labels it would set, the handoff it would ask for). Sends nothing and changes nothing. The first reply only starts the flow, as a first message does. `definition` tries an unsaved version.",
      access: "session",
      permission: USE,
      readOnly: true,
      input: {
        params: ParamId,
        body: z.object({
          replies: z
            .array(z.union([z.string().max(1000), z.object({ id: z.string().min(1).max(256), title: z.string().max(100).optional() })]))
            .max(50)
            .default([])
            .describe("A text, or {id} for a tapped button or list row"),
          channelKind: z.enum(["whatsapp", "messenger", "instagram", "webchat"]).default("whatsapp").describe("Without interactive messages, menus become numbered text"),
          definition: Definition.optional(),
        }),
      },
      output: { schema: Output },
    },
    async (c, input, h) => {
      await requireMember(db(), h.user);
      const [f] = (await db().select().from(koeFlows).where(eq(koeFlows.id, input.params.id)).limit(1)) as FlowRow[];
      if (!f) throw AppError.notFound("Flow not found");
      const def = (input.body.definition ?? f.definition) as unknown;
      const { problems, warnings } = checkFlow(def);
      if (problems.length) throw AppError.validation(`The flow has problems: ${problems.join("; ")}`, { koe: "FLOW_INVALID", problems });
      const result = await simulateFlow(def as FlowDefinition, input.body.replies, { interactive: adapterOf(input.body.channelKind).capabilities.interactive, name: f.name });
      return c.json({ data: { ...result, warnings } });
    }
  );
};
