/**
 * The CRM agent eval with a real model — costs money, so it only runs when the owner says so
 * ============================================================================
 *
 *   CRM_EVAL_APPROVE=yes pnpm exec vitest run tests/evals/crm-agents/claude.test.ts
 *
 * Optional: CRM_EVAL_MODEL (default claude-opus-5-5), CRM_EVAL_EFFORT (default high), CRM_EVAL_REPEATS (default 1),
 * CRM_EVAL_CASES (comma-separated ids). Credentials come from the environment the SDK reads (ANTHROPIC_API_KEY or
 * an `ant auth login` profile). Without CRM_EVAL_APPROVE=yes every test here is skipped: the normal suite spends
 * nothing. The results, with each attempt's trace, go to `.results/` next to this file.
 *
 * A manual loop and not the SDK's tool runner: each tool result goes back exactly as the CRM answered it, with
 * `is_error` on a 4xx/5xx, and every call is kept in the trace next to its result. That is what is measured.
 *
 * The system prompt is minimal on purpose: if the domain had to be explained there for the agent to get it right,
 * the tools and their descriptions would not be doing their job. The agent is told only to start from the guide.
 *
 * A turn that a refusal sent to another model (`fallbacks`) is marked and not scored: another model solved it.
 */

import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { CASES } from "./cases";
import { createEnv, seed, type EvalEnv } from "./env";

const APPROVED = process.env.CRM_EVAL_APPROVE === "yes";
const MODEL = process.env.CRM_EVAL_MODEL ?? "claude-opus-5-5";
const EFFORT = (process.env.CRM_EVAL_EFFORT ?? "high") as "low" | "medium" | "high" | "xhigh" | "max";
const REPEATS = Math.max(1, Number(process.env.CRM_EVAL_REPEATS) || 1);
const ONLY = (process.env.CRM_EVAL_CASES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_TURNS = 15;

const SYSTEM =
  "You are an assistant working in a business's CRM through the tools you are given. Do what the user asks. " +
  "Call crm__get-agent-guide first. When you are done, answer the user in a few sentences.";

interface Step {
  role: "assistant" | "tool_call" | "tool_result";
  name?: string;
  content: string;
}

interface Attempt {
  caseId: string;
  attempt: number;
  passed: boolean;
  failures: string[];
  answer: string;
  scored: boolean;
  stopReason: string | null;
  turns: number;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  trace: Step[];
}

async function runAgent(client: Anthropic, env: EvalEnv, prompt: string): Promise<Omit<Attempt, "caseId" | "attempt" | "passed" | "failures">> {
  const tools = env.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) as Anthropic.Beta.BetaTool[];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
  const trace: Step[] = [];
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let answer = "";
  let stopReason: string | null = null;
  let scored = true;
  let turns = 0;

  while (turns < MAX_TURNS) {
    turns++;
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      tools,
      messages,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: EFFORT },
      // Tools and system do not change between turns: the prefix is cached.
      cache_control: { type: "ephemeral" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming);
    usage.input += response.usage.input_tokens;
    usage.output += response.usage.output_tokens;
    usage.cacheRead += response.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += response.usage.cache_creation_input_tokens ?? 0;
    stopReason = response.stop_reason;
    if (response.content.some((b) => (b as { type: string }).type === "fallback")) scored = false;

    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (text) trace.push({ role: "assistant", content: text });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason !== "tool_use") {
      answer = text;
      break;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      trace.push({ role: "tool_call", name: block.name, content: JSON.stringify(input) });
      const result = await env.call(block.name, input);
      const content = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
      trace.push({ role: "tool_result", name: block.name, content: `${result.status} ${content.slice(0, 4000)}` });
      results.push({ type: "tool_result", tool_use_id: block.id, content, is_error: result.isError });
    }
    // Every result of the turn in one message, so parallel calls stay parallel.
    messages.push({ role: "user", content: results });
  }
  return { answer, scored, stopReason, turns, usage, trace };
}

describe.skipIf(!APPROVED)(`CRM agent eval with ${MODEL} (${EFFORT})`, () => {
  const cases = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
  const attempts: Attempt[] = [];

  for (const c of cases) {
    for (let attempt = 1; attempt <= REPEATS; attempt++) {
      it(`${c.id} #${attempt}`, { timeout: 600_000 }, async () => {
        const client = new Anthropic({ maxRetries: 4 });
        const env = await createEnv(c.toolset);
        try {
          await seed(env);
          await c.prepare?.(env);
          const run = await runAgent(client, env, c.prompt);
          const grade = await c.grade(env, run.answer);
          attempts.push({ caseId: c.id, attempt, ...run, ...grade });
          // Recorded either way; the summary is the result, not this assertion.
          expect(typeof grade.passed).toBe("boolean");
        } finally {
          await env.close();
        }
      });
    }
  }

  it("writes the results", () => {
    const scoredOnes = attempts.filter((a) => a.scored);
    const summary = {
      model: MODEL,
      effort: EFFORT,
      repeats: REPEATS,
      passed: scoredOnes.filter((a) => a.passed).length,
      scored: scoredOnes.length,
      unscored: attempts.length - scoredOnes.length,
      byCase: Object.fromEntries(
        cases.map((c) => [c.id, attempts.filter((a) => a.caseId === c.id && a.scored).map((a) => (a.passed ? "pass" : `fail: ${a.failures.join("; ")}`))])
      ),
      usage: attempts.reduce(
        (sum, a) => ({ input: sum.input + a.usage.input, output: sum.output + a.usage.output, cacheRead: sum.cacheRead + a.usage.cacheRead, cacheWrite: sum.cacheWrite + a.usage.cacheWrite }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      ),
    };
    const dir = resolve(__dirname, ".results");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${MODEL}.json`);
    writeFileSync(file, JSON.stringify({ summary, attempts }, null, 2));
    console.log(JSON.stringify(summary, null, 2), `\nResults: ${file}`);
  });
});
