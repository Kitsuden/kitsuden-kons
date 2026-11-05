/**
 * The agent under test: Claude with the domain tools
 * ============================================================================
 *
 * Manual loop and not the SDK's tool runner: each result has to go back to
 * Claude with `is_error` exactly as the MCP server returns it, and each
 * call has to be recorded in the trace next to its result. That is what is measured.
 *
 * The agent sees the same as in production: the name, description and schema of
 * each tool, and what it returns. The system prompt is minimal on
 * purpose —that of any coding assistant—: if the domain had to be
 * explained to it there for it to get things right, the MCP would not be doing its
 * job.
 *
 * ── THE CALL ───────────────────────────────────────────────────────────────
 *
 *   · Adaptive thinking, summarized so the trace can be read.
 *   · Automatic cache: tools and system do not change between turns.
 *   · Server fallback (`fallbacks: "default"`) on a refusal. If it ends up
 *     being used, the attempt is not scored: another model would have solved it.
 *   · Retries with random backoff only on 429, 529, 5xx and connection failures,
 *     and counted. The client is created with `maxRetries: 0` so the SDK's
 *     retries do not add to these without leaving a trace.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaFallbackParam,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaUsage,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";

import { runDomainTool } from "../../../../packages/mcp-server/src/domain-tools";
import { AGENT_TOOLS, type Environment } from "./environment";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** One turn of the trace, in the form the evaluations report reads. */
export interface Turn {
  role: "system" | "user" | "assistant" | "tool_call" | "tool_result";
  content: string;
  name?: string;
  thinking?: string;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface Execution {
  transcript: Turn[];
  model: string | null;
  usage: Usage;
  stop_reason: string;
  tool_calls: number;
  tool_errors: number;
  turns: number;
  reintentos: number;
  /** Some response was served by the fallback model after a refusal. */
  backup: boolean;
}

export const SYSTEM =
  "You are the programming assistant of someone building a gaming app on a Kitsuden backend, and you have their MCP tools. Do what they ask using those tools. When you finish, summarize in one or two sentences what you did, or what could not be done and why.";

/** Turn ceiling per case: a loop that does not converge must not spend endlessly. */
export const MAX_TURNS = 40;

const ALLOWED_ONES = new Set(AGENT_TOOLS.map((d) => d.name));

const TOOLS: BetaTool[] = AGENT_TOOLS.map((d) => ({
  name: d.name,
  description: d.description,
  input_schema: d.inputSchema,
}));

// SDK 0.111 only types `fallbacks` as a list of models. "default" —the
// recommended one— picks the fallback by the category of the refusal; until the
// type picks it up, it is forced here.
const DEFAULT_BACKUP = "default" as unknown as BetaFallbackParam[];

export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

function addUsage(total: Usage, usage: BetaUsage) {
  total.input_tokens += usage.input_tokens;
  total.output_tokens += usage.output_tokens;
  total.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  total.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
}

function isTransient(error: unknown): boolean {
  if (error instanceof Anthropic.APIConnectionError) return true;
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    return status === 429 || status === 529 || status >= 500;
  }
  return false;
}

async function withRetries<T>(
  call: () => Promise<T>,
  account: { n: number },
  limit: number
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    // Before EACH call: past the case ceiling, an abandoned loop
    // must not keep calling the model.
    if (Date.now() >= limit) {
      throw Object.assign(new Error("the case timed out before calling the model"), {
        failure_class: "timeout",
      });
    }
    try {
      return await call();
    } catch (error) {
      if (!isTransient(error) || attempt >= 4) throw error;
      const wait = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
      if (Date.now() + wait >= limit) throw error;
      account.n++;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

function annotateInTrace(trace: Turn[], blocks: BetaContentBlock[]) {
  let thought: string | undefined;
  const withThought = () => (thought ? { thinking: thought } : {});

  for (const b of blocks) {
    if (b.type === "thinking") {
      thought = [thought, b.thinking].filter(Boolean).join("\n\n") || undefined;
    } else if (b.type === "text") {
      trace.push({ role: "assistant", content: b.text, ...withThought() });
      thought = undefined;
    } else if (b.type === "tool_use") {
      trace.push({
        role: "tool_call",
        name: b.name,
        content: JSON.stringify(b.input, null, 2),
        ...withThought(),
      });
      thought = undefined;
    } else if (b.type === "fallback") {
      trace.push({
        role: "assistant",
        content: "[from here on the fallback model responds]",
      });
    }
  }
}

export async function runWithClaude(
  prompt: string,
  environment: Environment,
  options: { client: Anthropic; model: string; effort: Effort; limit: number }
): Promise<Execution> {
  const messages: BetaMessageParam[] = [{ role: "user", content: prompt }];
  const transcript: Turn[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: prompt },
  ];
  const usage = emptyUsage();
  const reintentos = { n: 0 };
  let model: string | null = null;
  let stop_reason = "";
  let tool_calls = 0;
  let tool_errors = 0;
  let turns = 0;
  let backup = false;

  try {
    while (turns < MAX_TURNS) {
      turns++;
      const res = await withRetries(
        () =>
          options.client.beta.messages.create({
            model: options.model,
            max_tokens: 16000,
            system: SYSTEM,
            tools: TOOLS,
            messages,
            thinking: { type: "adaptive", display: "summarized" },
            output_config: { effort: options.effort },
            cache_control: { type: "ephemeral" },
            betas: ["server-side-fallback-2026-07-01"],
            fallbacks: DEFAULT_BACKUP,
          }),
        reintentos,
        options.limit
      );

      model = res.model;
      addUsage(usage, res.usage);
      if (res.usage.iterations?.some((it) => it.type === "fallback_message")) backup = true;
      stop_reason = res.stop_reason ?? "";

      // The whole turn, thinking included: returned untouched.
      messages.push({ role: "assistant", content: res.content });
      annotateInTrace(transcript, res.content);

      if (res.stop_reason === "pause_turn") continue;
      if (res.stop_reason !== "tool_use") break;

      // One result per call, all in the SAME message: splitting them teaches
      // the model to stop making parallel calls.
      const results: BetaToolResultBlockParam[] = [];
      for (const block of res.content) {
        if (block.type !== "tool_use") continue;
        tool_calls++;
        const r = ALLOWED_ONES.has(block.name)
          ? await runDomainTool(
              block.name,
              (block.input ?? {}) as Record<string, unknown>,
              environment.api
            )
          : null;
        const text = r ? r.content[0].text : `Tool «${block.name}» is not available.`;
        const isError = !r || r.isError === true;
        if (isError) tool_errors++;
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: text,
          ...(isError ? { is_error: true } : {}),
        });
        transcript.push({ role: "tool_result", name: block.name, content: text });
      }
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    // What was spent until the failure also counts: it travels with the error to the log.
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      failure_class:
        (error as { failure_class?: string }).failure_class ??
        (error instanceof Anthropic.APIError ? "api_error" : "harness_error"),
      usage,
      model,
      retries: reintentos.n,
    });
  }

  if (turns >= MAX_TURNS && stop_reason === "tool_use") stop_reason = "max_turns";

  return {
    transcript,
    model,
    usage,
    stop_reason,
    tool_calls,
    tool_errors,
    turns,
    reintentos: reintentos.n,
    backup,
  };
}
