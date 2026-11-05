/**
 * The CRM agent eval, checked for free: the oracle passes every case, an agent that does nothing passes none
 * ============================================================================
 *
 * A case the oracle cannot solve is a gap in the CRM or a badly made case; a case a do-nothing agent passes
 * measures nothing. Both are checked here on every run of the suite. Running a real model is `run-claude.ts`,
 * which costs money and needs the owner's approval.
 */

import { describe, expect, it } from "vitest";

import { CASES } from "./cases";
import { createEnv, seed } from "./env";

describe.each(CASES)("$id", (c) => {
  it("the oracle solves it", async () => {
    const env = await createEnv(c.toolset);
    try {
      await seed(env);
      await c.prepare?.(env);
      const answer = (await c.oracle(env)) ?? "";
      expect(await c.grade(env, answer)).toEqual({ passed: true, failures: [] });
    } finally {
      await env.close();
    }
  });

  it("doing nothing does not pass", async () => {
    const env = await createEnv(c.toolset);
    try {
      await seed(env);
      await c.prepare?.(env);
      expect((await c.grade(env, "")).passed).toBe(false);
    } finally {
      await env.close();
    }
  });

  it("every tool of its group reaches the agent", async () => {
    const env = await createEnv(c.toolset);
    try {
      expect(env.tools.length).toBeGreaterThan(5);
      expect(env.tools.every((t) => t.name.startsWith("crm__") && t.description.length > 20)).toBe(true);
    } finally {
      await env.close();
    }
  });
});
