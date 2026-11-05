#!/usr/bin/env bun
/**
 * Evaluation: does an agent build in the niche with Kitsuden's MCP tools?
 * ============================================================================
 *
 * From the repository root:
 *
 *   bun apps/api/evals/agents-mcp/run.ts --agent oraculo    # no cost: the ceiling, ~100 %
 *   bun apps/api/evals/agents-mcp/run.ts --agent nulo       # no cost: the floor, ~0 %
 *   bun apps/api/evals/agents-mcp/run.ts --agent claude --reps 3   # calls the API: costs money
 *
 * With bun and not vitest: the unit suite's setup replaces `global.fetch`
 * with a mock, and the Anthropic SDK uses it to call the API.
 *
 * Per case, `completed` (the final state is the requested one; this is the
 * headline metric) and `limpio` (completed with no failed call along the way) are scored.
 * Calls, tool errors, turns, time and tokens are also recorded.
 *
 * Adapted from the `runner-scaffold.mjs` of the Claude API evaluations skill,
 * whose properties it keeps: rows written as they finish and resumption by
 * (case, repetition); infrastructure failures kept apart, in
 * `errors.jsonl`, without taking up a result's slot; retries with random
 * backoff, counted; a per-case time ceiling; a check of the model that
 * responded, and the harness integrity gate.
 *
 * The gate only applies to `--agent claude`, the run that costs money and
 * can run unattended. Approving the harness (`--approve-harness`) is up to
 * whoever has reviewed it.
 *
 * `oraculo` and `nullable` write to `<flow>/_auditoria/<agent>/`, outside the variant
 * directories, so the report does not mix them with Claude.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type Anthropic from "@anthropic-ai/sdk";

import type { Execution, Effort } from "./claude-agent";
import type { Grade, Scenario } from "./cases";
import type { Environment } from "./environment";

// Before loading anything from the API: some modules read these variables when
// imported. That is why the rest is imported inside `main`.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://eval:eval@localhost:5432/eval";

type Agent = "claude" | "oraculo" | "nullable";

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const SEPARATOR = String.fromCharCode(0);

interface Options {
  flow: string;
  variant: string;
  agent: Agent;
  model: string;
  effort: Effort;
  reps: number;
  concurrency: number;
  timeoutS: number;
  cases: string[] | null;
  approveHarness: boolean;
}

interface Status {
  harness_paths?: unknown;
  harness_sha?: string;
  [key: string]: unknown;
}

interface ResultRow {
  prompt_id: string;
  rep: number;
  status?: string;
  grade: { completed: number; clean: number };
  meta?: { failures?: string[] };
}

type ErrorWithData = Error & {
  failure_class?: string;
  usage?: unknown;
  model?: string | null;
  retries?: number;
};

function usage(): void {
  console.error(
    "usage: bun apps/api/evals/agents-mcp/run.ts [--agent claude|oraculo|nulo] [--variant baseline|vN] [--model ID] [--effort low|medium|high|xhigh|max] [--reps N] [--concurrency N] [--timeout-s N (0 = no ceiling)] [--cases id,id] [--flow DIR] [--approve-harness]"
  );
}

function parsear(argv: string[]): Options {
  const o: Options = {
    flow: ".claude/hillclimb/agentes-mcp",
    variant: "baseline",
    agent: "claude",
    model: "claude-opus-5",
    effort: "high",
    reps: 1,
    concurrency: 3,
    timeoutS: 900,
    cases: null,
    approveHarness: false,
  };
  // A trailing flag with no value would consume `undefined`; with --model that
  // would silently disable the check of the model that responds.
  const value = (i: number): string => {
    const v = argv[i];
    if (v === undefined) {
      console.error(`missing value for ${argv[i - 1]}`);
      usage();
      process.exit(2);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--flow") o.flow = value(++i);
    else if (k === "--variant") o.variant = value(++i);
    else if (k === "--agent") o.agent = value(++i) as Agent;
    else if (k === "--model") o.model = value(++i);
    else if (k === "--effort") o.effort = value(++i) as Effort;
    else if (k === "--reps") o.reps = Number(value(++i));
    else if (k === "--concurrency") o.concurrency = Number(value(++i));
    else if (k === "--timeout-s") o.timeoutS = Number(value(++i));
    else if (k === "--cases") {
      o.cases = value(++i)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (k === "--approve-harness") o.approveHarness = true;
    else if (k === "-h" || k === "--help") {
      usage();
      process.exit(0);
    } else {
      console.error(`unknown argument: ${k}`);
      usage();
      process.exit(2);
    }
  }

  const problems = [
    !["claude", "oraculo", "nullable"].includes(o.agent) && "--agent must be claude, oraculo or nulo",
    // The report only reads `baseline` or `v<N>` directories: with any other name the
    // run is spent somewhere nobody looks.
    !/^(baseline|v[1-9][0-9]*)$/.test(o.variant) && "--variant must be 'baseline' or 'v<N>'",
    !EFFORTS.includes(o.effort) && `--effort must be one of: ${EFFORTS.join(", ")}`,
    !(Number.isInteger(o.reps) && o.reps >= 1) && "--reps must be an integer greater than 0",
    !(Number.isInteger(o.concurrency) && o.concurrency >= 1) &&
      "--concurrency must be an integer greater than 0",
    // setTimeout clips anything above 2^31-1 ms to 1 ms: the ceiling would trigger instantly.
    !(Number.isFinite(o.timeoutS) && o.timeoutS >= 0 && o.timeoutS * 1000 <= 2147483647) &&
      "--timeout-s out of range",
  ].filter((p): p is string => typeof p === "string");
  if (problems.length) {
    for (const p of problems) console.error(p);
    usage();
    process.exit(2);
  }
  return o;
}

/**
 * Harness integrity gate: sha256 over this file and those in
 * `_state.json.harness_paths`. If it does not match the approved one, it does not run
 * until someone reviews it and passes `--approve-harness`. It is the only write
 * allowed on `_state.json`.
 */
function checkHarness(statusPath: string, status: Status, approve: boolean): void {
  const ownValue = fileURLToPath(import.meta.url);
  const listed = Array.isArray(status.harness_paths) ? status.harness_paths.map(String) : [];
  const routes = [...new Set([ownValue, ...listed.map((p) => resolve(p))])].sort();
  const hash = createHash("sha256");
  const included: string[] = [];

  for (const route of routes) {
    let content: Buffer;
    try {
      content = readFileSync(route);
    } catch (error) {
      if (route === ownValue) throw error;
      console.error(`warning: '${relative(process.cwd(), route)}' cannot be read; skipped`);
      continue;
    }
    const name = relative(process.cwd(), route).split(sep).join("/");
    hash.update(name).update(SEPARATOR).update(content).update(SEPARATOR);
    included.push(name);
  }

  const sha = hash.digest("hex");
  if (status.harness_sha === sha) return;
  if (approve) {
    status.harness_sha = sha;
    writeFileSync(statusPath, JSON.stringify(status, null, 2) + "\n");
    console.error(`harness approved: sha256 ${sha.slice(0, 12)} on ${included.length} ficheros`);
    return;
  }
  if (status.harness_sha == null) {
    console.error(`there is no approved harness in ${statusPath} (computed ${sha.slice(0, 12)}).`);
  } else {
    console.error(
      `the harness changed since the last approval: ${status.harness_sha.slice(0, 12)} → ${sha.slice(0, 12)}.`
    );
  }
  console.error(`Ficheros: ${included.join(", ")}`);
  console.error("Review it and run once with --approve-harness.");
  process.exit(2);
}

/**
 * Time ceiling over the whole case. What runs inside may continue a
 * little —the agent checks the limit before each model call—, but
 * the slot is freed and the attempt is recorded as `timeout`, not as a zero.
 */
function withCeiling<T>(promise: Promise<T>, seconds: number, tag: string): Promise<T> {
  if (!(seconds > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`${tag}: exceeded the ceiling of ${seconds}s`), {
            failure_class: "timeout",
          })
        ),
      seconds * 1000
    );
  });
  return Promise.race([promise, ceiling]).finally(() => clearTimeout(timer));
}

function readJsonl<T>(route: string): T[] {
  if (!existsSync(route)) return [];
  const rows: T[] = [];
  for (const line of readFileSync(route, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // A line broken by a half-written cut does not invalidate the others.
    }
  }
  return rows;
}

function localExecution(prompt: string, emptyUsage: () => Execution["usage"]): Execution {
  return {
    transcript: [{ role: "user", content: prompt }],
    model: null,
    usage: emptyUsage(),
    stop_reason: "local",
    tool_calls: 0,
    tool_errors: 0,
    turns: 0,
    reintentos: 0,
    backup: false,
  };
}

/**
 * The model that responded has to be the one requested. The documented
 * alias-to-snapshot resolution is accepted (`foo` served as `foo-20260101`); a
 * fallback after a refusal or any other model invalidates the attempt.
 */
function checkModel(ejec: Execution, request: string): void {
  const failure = (message: string) =>
    Object.assign(new Error(message), {
      failure_class: "serving_substitution",
      usage: ejec.usage,
      model: ejec.model,
      retries: ejec.reintentos,
    });
  if (ejec.backup) throw failure(`the fallback model responded (${ejec.model}) after a refusal`);
  if (!ejec.model || ejec.model === request) return;
  const base = request.replace(/-latest$|-0$/, "");
  const rest = ejec.model.startsWith(base) ? ejec.model.slice(base.length) : null;
  if (rest !== null && /^[-@]([0-9]{8}|[0-9]{4}-[0-9]{2}-[0-9]{2})$/.test(rest)) return;
  throw failure(`responded ${ejec.model}; requested ${request}`);
}

async function runOnce(
  scenario: Scenario,
  o: Options,
  createEnvironment: () => Promise<Environment>,
  claude: typeof import("./claude-agent") | null,
  client: Anthropic | null,
  emptyUsage: () => Execution["usage"],
  limit: number
): Promise<{ ejec: Execution; cal: Grade; latency_s: number }> {
  const withKind = (error: unknown, kind: string) =>
    Object.assign(error instanceof Error ? error : new Error(String(error)), {
      failure_class: kind,
    });

  const environment = await createEnvironment();
  try {
    if (scenario.prepare) {
      try {
        await scenario.prepare(environment);
      } catch (error) {
        throw withKind(error, "preparacion");
      }
    }

    const start = Date.now();
    let ejec: Execution;
    if (claude && client) {
      ejec = await claude.runWithClaude(scenario.prompt, environment, {
        client,
        model: o.model,
        effort: o.effort,
        limit,
      });
      checkModel(ejec, o.model);
    } else {
      if (o.agent === "oraculo") {
        try {
          await scenario.oracle(environment);
        } catch (error) {
          throw withKind(error, "oraculo");
        }
      }
      ejec = localExecution(scenario.prompt, emptyUsage);
    }
    const latency_s = (Date.now() - start) / 1000;

    let grade: Grade;
    try {
      grade = await scenario.grade(environment);
    } catch (error) {
      throw Object.assign(withKind(error, "calificador"), {
        usage: ejec.usage,
        model: ejec.model,
      });
    }
    return { ejec, cal: grade, latency_s };
  } finally {
    await environment.close();
  }
}

function summarize(route: string, ids: Set<string>, tag: string): void {
  const rows = readJsonl<ResultRow>(route).filter((f) => ids.has(f.prompt_id));
  const scored = rows.filter((f) => f.status !== "truncated");
  const n = scored.length;
  if (!n) {
    console.error(`[${tag}] no scored rows`);
    return;
  }
  const completedItems = scored.filter((f) => f.grade.completed === 1).length;
  const clean = scored.filter((f) => f.grade.clean === 1).length;
  const p = completedItems / n;
  // Approximate 95 % CI (Wald): with few rows it is only indicative, and it says so.
  const margin = 1.96 * Math.sqrt((p * (1 - p)) / n);
  const pct = (x: number) => `${Math.round(x * 100)} %`;
  console.error(
    `[${tag}] completed: ${completedItems}/${n} (${pct(p)} ± ${pct(margin)}, approx. 95 % CI) · no errors: ${clean}/${n}` +
      (rows.length > n ? ` · ${rows.length - n} truncated, not scored` : "")
  );
  for (const f of scored.filter((x) => x.grade.completed !== 1)) {
    console.error(`  ✗ ${f.prompt_id} rep${f.rep}: ${(f.meta?.failures ?? []).join(" · ")}`);
  }
}

async function main(): Promise<void> {
  const o = parsear(process.argv.slice(2));
  const tag = o.agent === "claude" ? o.variant : o.agent;
  const output =
    o.agent === "claude" ? join(o.flow, o.variant) : join(o.flow, "_auditoria", o.agent);
  mkdirSync(join(output, "traces"), { recursive: true });

  // _state.json is READ-ONLY here, except for the harness approval.
  const statusPath = join(o.flow, "_state.json");
  let status: Status = {};
  if (existsSync(statusPath)) {
    try {
      status = (JSON.parse(readFileSync(statusPath, "utf8")) as Status) ?? {};
    } catch (error) {
      console.error(`${statusPath} is not valid JSON (${(error as Error).message})`);
      process.exit(2);
    }
  }
  if (o.agent === "claude") checkHarness(statusPath, status, o.approveHarness);

  const { CASES } = await import("./cases");
  const { createEnvironment } = await import("./environment");
  const agent = await import("./claude-agent");
  const claude = o.agent === "claude" ? agent : null;
  const client = claude
    ? new (await import("@anthropic-ai/sdk")).default({ maxRetries: 0 })
    : null;

  for (const c of CASES) {
    if (!/^[a-z0-9-]+$/.test(c.id)) {
      console.error(`case id not suitable as a file name: ${c.id}`);
      process.exit(2);
    }
  }
  if (new Set(CASES.map((c) => c.id)).size !== CASES.length) {
    console.error("duplicate case ids");
    process.exit(2);
  }
  const unknownAll = (o.cases ?? []).filter((id) => !CASES.some((c) => c.id === id));
  if (unknownAll.length) {
    console.error(`unknown cases: ${unknownAll.join(", ")}`);
    process.exit(2);
  }
  const cases = o.cases ? CASES.filter((c) => o.cases!.includes(c.id)) : CASES;

  const resultsPath = join(output, "results.jsonl");
  const errorsPath = join(output, "errors.jsonl");
  const facts = new Set(
    readJsonl<ResultRow>(resultsPath).map((f) => `${f.prompt_id}#${f.rep}`)
  );
  // A half-done cut can leave the last line without a newline: the next row
  // would stick to it and both would be unreadable.
  for (const route of [resultsPath, errorsPath]) {
    if (!existsSync(route)) continue;
    const buf = readFileSync(route);
    if (buf.length && buf[buf.length - 1] !== 0x0a) appendFileSync(route, "\n");
  }

  const tasks = cases
    .flatMap((scenario) => Array.from({ length: o.reps }, (_, rep) => ({ scenario, rep })))
    .filter(({ scenario: scenario, rep }) => !facts.has(`${scenario.id}#${rep}`));
  console.error(
    `[${tag}] ${tasks.length} de ${cases.length * o.reps} (case, rep) left to run`
  );

  let next = 0;
  let errors = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const { scenario: scenario, rep } = tasks[next++];
      const t0 = Date.now();
      const limit = o.timeoutS > 0 ? t0 + o.timeoutS * 1000 : Number.POSITIVE_INFINITY;
      let written = false;
      try {
        const { ejec, cal: grade, latency_s } = await withCeiling(
          runOnce(scenario, o, createEnvironment, claude, client, agent.emptyUsage, limit),
          o.timeoutS,
          `${scenario.id} rep${rep}`
        );
        const row = {
          prompt_id: scenario.id,
          rep,
          prompt: scenario.prompt,
          tags: scenario.tags,
          meta: {
            agent: o.agent,
            ...(claude ? { effort: o.effort } : {}),
            ...(ejec.reintentos ? { retries: ejec.reintentos } : {}),
            ...(ejec.stop_reason === "max_turns" ? { turn_limit: true } : {}),
            ...(grade.failures.length ? { failures: grade.failures } : {}),
          },
          model: ejec.model,
          usage: ejec.usage,
          stop_reason: ejec.stop_reason,
          status: ejec.stop_reason === "max_tokens" ? "truncated" : "ok",
          latency_s,
          tool_calls: ejec.tool_calls,
          tool_errors: ejec.tool_errors,
          turns: ejec.turns,
          grade: {
            completed: grade.completed ? 1 : 0,
            clean: grade.completed && ejec.tool_errors === 0 ? 1 : 0,
          },
          explanation: {
            completed: grade.completed ? "The final state is the one requested." : grade.failures.join(" · "),
          },
        };
        appendFileSync(resultsPath, JSON.stringify(row) + "\n");
        written = true;
        writeFileSync(
          join(output, "traces", `${scenario.id}_rep${rep}.json`),
          JSON.stringify(ejec.transcript, null, 2)
        );
        console.error(
          `  ${grade.completed ? "✓" : "✗"} ${scenario.id} rep${rep}` +
            (grade.completed ? "" : `: ${grade.failures.join(" · ")}`)
        );
      } catch (error) {
        const e = error as ErrorWithData;
        if (written) {
          // The attempt is already scored: another row in errors would count its cost twice.
          console.error(
            `  ${scenario.id} rep${rep} scored, but the trace could not be written: ${e.message}`
          );
          continue;
        }
        errors++;
        appendFileSync(
          errorsPath,
          JSON.stringify({
            prompt_id: scenario.id,
            rep,
            failure_class: e.failure_class ?? "error",
            error: String(e?.message ?? e),
            retries: e.retries ?? 0,
            model: e.model ?? null,
            usage: e.usage ?? null,
            latency_s: (Date.now() - t0) / 1000,
          }) + "\n"
        );
        console.error(`  ! ${scenario.id} rep${rep} [${e.failure_class ?? "error"}]: ${e.message}`);
      }
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, worker));
  summarize(resultsPath, new Set(cases.map((c) => c.id)), tag);
  if (errors) console.error(`[${tag}] ${errors} attempts not scored → ${errorsPath}`);
  process.exit(errors ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
