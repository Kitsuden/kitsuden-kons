/**
 * kon-academy-lms — no IDOR and no answers before answering
 * ============================================================================
 *
 * Audit 2026-10-15. What there was:
 *
 *   · Management asked the host for `requireRole(["administrator","supervisor"])`,
 *     which looks at the GLOBAL role: nobody is a "supervisor" there, so it
 *     answered 403 to everyone (including the admin)…
 *   · …while the routes without `requireRole` were open to ANY
 *     account (public sign-up): `GET /course_modules/:id` and `GET /quizzes/:id` returned
 *     the quiz with `isCorrect` on each option; `GET /courses/:id` too, to the
 *     student, before answering; `GET /groups` gave all groups with their
 *     members to anyone without a profile; `POST /topics/:id/complete` and
 *     `POST /quizzes/:id/answer` did not check the course; `GET /topics/:id`
 *     attached the user row of whoever left feedback.
 *
 * Against PGlite with the kon's real migrations and several users.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { AppError } from "@kitsuden/engine";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestKonContext } from "../../.kitsuden/apps/api/src/lib/test-kon-context";
import { createAcademyLMSRoutes } from "../../kons/kon-academy-lms/academy-lms.routes";
import * as schema from "../../kons/kon-academy-lms/academy-lms.schema";
import { registerAcademyPolicy } from "../../kons/kon-academy-lms/academy.policy";
import { validateCertificateCode } from "../../kons/kon-academy-lms/services/pdf.service";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(here, "../../kons/kon-academy-lms/migrations");

let client: PGlite;
let app: Hono;
let session: { id: string; role: string; name?: string } | null = null;

const ADMIN = { id: "u-admin", role: "admin" };
const ACADEMY_ADMIN = { id: "u-jefa", role: "user" };
const SUPERVISOR = { id: "u-super", role: "user" };
const ANA = { id: "u-ana", role: "user", name: "Ana" }; // assigned to C1 directly
const CARLA = { id: "u-carla", role: "user" }; // assigned to C1 through their group
const BEA = { id: "u-bea", role: "user" }; // assigned only to C2
const INTRUDER = { id: "u-intruso", role: "user" }; // public sign-up, no profile

beforeAll(async () => {
  client = await PGlite.create();
  await client.exec(readFileSync(resolve(MIG, "0000_initial.sql"), "utf8"));
  await client.exec(readFileSync(resolve(MIG, "0001_media_references.sql"), "utf8"));
  await client.exec(readFileSync(resolve(MIG, "0002_unique_indexes.sql"), "utf8"));
  await client.exec(readFileSync(resolve(MIG, "0006_english_names.sql"), "utf8"));
  registerAcademyPolicy();

  const ctx = createTestKonContext({
    db: {
      instance: drizzle(client, { schema }),
      execute: async () => undefined,
      tableExists: async () => true,
    },
    auth: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Hono middleware double
      requireAuth: (c: any, next: any) => {
        if (!session) return c.json({ error: "no session" }, 401);
        c.set("user", session);
        return next();
      },
      // If any route kept using the host's requireRole, this double
      // would give it away: it always denies.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- double
      requireRole: () => (c: any) => c.json({ error: "the host's requireRole" }, 418),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);

  app = new Hono();
  app.onError((err) => {
    if (err instanceof AppError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    return Response.json({ error: String(err) }, { status: 500 });
  });
  app.route("/", createAcademyLMSRoutes(ctx) as unknown as Hono);
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  session = null;
  await client.exec(`
    TRUNCATE training_user_profiles, courses, assignment_groups, group_users,
      course_modules, topics, quizzes, questions, question_options, course_progress, topic_progress,
      user_answers, quiz_results, assignments, feedback, certificates,
      satisfaction_surveys, academy_activity_log CASCADE;

    INSERT INTO training_user_profiles (id, user_id, training_role) VALUES
      ('pf1', 'u-jefa', 'administrator'), ('pf2', 'u-super', 'supervisor'),
      ('pf3', 'u-ana', 'student'), ('pf4', 'u-bea', 'student'),
      ('pf5', 'u-carla', 'student');

    INSERT INTO courses (id, title, description) VALUES
      ('c1', 'Seguridad', 'Curso 1'), ('c2', 'Other', 'Curso 2');
    INSERT INTO course_modules (id, course_id, title, position) VALUES ('m1', 'c1', 'Module 1', 1);
    INSERT INTO topics (id, module_id, title, content, position) VALUES
      ('t1', 'm1', 'Tema 1', 'content', 1);
    INSERT INTO quizzes (id, module_id, title, min_passing_score) VALUES
      ('q1', 'm1', 'Quiz 1', 100);
    INSERT INTO questions (id, quiz_id, text, score, position) VALUES
      ('p1', 'q1', '¿2+2?', 10, 1), ('p2', 'q1', '¿Capital?', 10, 2);
    INSERT INTO question_options (id, question_id, text, is_correct, position) VALUES
      ('o1', 'p1', '4', true, 1), ('o2', 'p1', '5', false, 2),
      ('o3', 'p2', 'Madrid', true, 1), ('o4', 'p2', 'Lugo', false, 2);

    INSERT INTO assignment_groups (id, name) VALUES ('g1', 'Turno de tarde');
    INSERT INTO group_users (id, group_id, user_id) VALUES ('gu1', 'g1', 'u-carla');

    INSERT INTO assignments (id, course_id, user_id, group_id) VALUES
      ('a1', 'c1', 'u-ana', NULL), ('a2', 'c1', NULL, 'g1'), ('a3', 'c2', 'u-bea', NULL);

    INSERT INTO feedback (id, user_id, topic_id, rating, comment) VALUES
      ('f1', 'u-carla', 't1', 4, 'Bien');
  `);
});

const request = async (method: string, route: string, body?: unknown) =>
  app.request(route, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const like = (u: { id: string; role: string; name?: string } | null) => {
  session = u;
};

describe("content of a course: only whoever has it assigned (or manages it)", () => {
  it.each(["/courses/c1", "/courses/c1/modules", "/modules/m1", "/quizzes/q1", "/topics/t1"])(
    "an account without an assignment gets 404 on %s",
    async (route) => {
      like(INTRUDER);
      expect((await request("GET", route)).status).toBe(404);
      like(BEA); // a student, but of ANOTHER course
      expect((await request("GET", route)).status).toBe(404);
    }
  );

  it("assignment through a GROUP also gives access", async () => {
    like(CARLA);
    expect((await request("GET", "/courses/c1")).status).toBe(200);
  });

  it("without a session: 401", async () => {
    expect((await request("GET", "/courses/c1")).status).toBe(401);
  });
});

describe("correct answers do not come out before answering", () => {
  it.each(["/courses/c1", "/modules/m1", "/quizzes/q1"])(
    "the student does not see isCorrect in %s",
    async (route) => {
      like(ANA);
      const res = await request("GET", route);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("o1"); // the options are there…
      expect(text).not.toContain("isCorrect"); // …but without saying which one
    }
  );

  it("the supervisor does see them (they edit them)", async () => {
    like(SUPERVISOR);
    const res = await request("GET", "/quizzes/q1");
    expect(await res.text()).toContain("isCorrect");
  });

  it("answering a quiz returns the grade, not the solutions", async () => {
    like(ANA);
    const res = await request("POST", "/quizzes/q1/answer", {
      answers: { p1: "o2", p2: "o3" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("o1");
    expect(text).not.toMatch(/correcta/i);
  });
});

describe("quizzes: no shortcuts", () => {
  it("an account without the course cannot answer", async () => {
    like(INTRUDER);
    expect((await request("POST", "/quizzes/q1/answer", { answers: {} })).status).toBe(404);
    const r = await client.query("SELECT 1 FROM quiz_results");
    expect(r.rows).toHaveLength(0);
  });

  it("an option from ANOTHER question does not score", async () => {
    like(ANA);
    // o3 is the correct one for p2; sending it as p1's answer is worth nothing.
    const res = await request("POST", "/quizzes/q1/answer", {
      answers: { p1: "o3", p2: "o4" },
    });
    expect((await res.json()).result.score).toBe(0);
  });

  it("attempts have a cap and a passed quiz is not repeated", async () => {
    like(ANA);
    for (let i = 0; i < 5; i++) {
      expect(
        (await request("POST", "/quizzes/q1/answer", { answers: { p1: "o2" } })).status
      ).toBe(200);
    }
    expect(
      (await request("POST", "/quizzes/q1/answer", { answers: { p1: "o1", p2: "o3" } })).status
    ).toBe(429);

    like(CARLA);
    expect(
      (await request("POST", "/quizzes/q1/answer", { answers: { p1: "o1", p2: "o3" } })).status
    ).toBe(200);
    expect(
      (await request("POST", "/quizzes/q1/answer", { answers: { p1: "o1", p2: "o3" } })).status
    ).toBe(409);
  });
});

describe("progress: each one their own", () => {
  it("topics from other people's courses are not completed", async () => {
    like(INTRUDER);
    expect((await request("POST", "/topics/t1/complete")).status).toBe(404);
    like(BEA);
    expect((await request("POST", "/topics/t1/complete")).status).toBe(404);
    const r = await client.query("SELECT 1 FROM topic_progress");
    expect(r.rows).toHaveLength(0);

    like(ANA);
    expect((await request("POST", "/topics/t1/complete")).status).toBe(200);
    const mine = await client.query<{ user_id: string }>("SELECT user_id FROM topic_progress");
    expect(mine.rows.map((x) => x.user_id)).toEqual(["u-ana"]);
  });

  it("a topic's feedback does not say who wrote it", async () => {
    like(ANA);
    const body = await (await request("GET", "/topics/t1")).json();
    expect(body.feedbacks).toHaveLength(1);
    expect(body.feedbacks[0]).not.toHaveProperty("userId");
    expect(body.feedbacks[0]).not.toHaveProperty("user");
    expect(body.feedbacks[0].yours).toBe(false);
  });

  it("you cannot leave feedback on topics from other people's courses", async () => {
    like(BEA);
    expect((await request("POST", "/feedback", { topicId: "t1", rating: 1 })).status).toBe(404);
  });

  it("a student does not see another's report", async () => {
    like(ANA);
    expect((await request("GET", "/reports/users/u-bea")).status).toBe(403);
    expect((await request("GET", "/reports/progress")).status).toBe(403);
    expect((await request("GET", "/export/progress")).status).toBe(403);
    expect((await request("GET", "/profiles")).status).toBe(403);
  });
});

describe("groups", () => {
  it("an account without a profile no longer sees all the groups with their members", async () => {
    like(INTRUDER);
    const body = await (await request("GET", "/groups")).json();
    expect(body.groups).toEqual([]);
    expect((await request("GET", "/groups/g1")).status).toBe(404);
  });

  it("a member sees their group but not the list of colleagues", async () => {
    like(CARLA);
    const list = await (await request("GET", "/groups")).json();
    expect(list.groups.map((g: { id: string }) => g.id)).toEqual(["g1"]);
    expect(list.groups[0]).not.toHaveProperty("members");
    const one = await (await request("GET", "/groups/g1")).json();
    expect(one.group).not.toHaveProperty("members");
  });

  it("the supervisor does see the members", async () => {
    like(SUPERVISOR);
    const one = await (await request("GET", "/groups/g1")).json();
    expect(one.group.members.map((m: { userId: string }) => m.userId)).toEqual(["u-carla"]);
  });
});

describe("management: the role that counts is the academy's", () => {
  const course = { title: "Nuevo", description: "x" };

  // Since the 2026-10-25 audit, course content belongs only to the
  // administrator: it is global and the supervisor used to change it for everyone.
  it("create course: global admin and administrador yes; supervisor, student and no profile no", async () => {
    for (const u of [ADMIN, ACADEMY_ADMIN]) {
      like(u);
      expect((await request("POST", "/courses", course)).status).toBe(201);
    }
    for (const u of [SUPERVISOR, ANA, INTRUDER]) {
      like(u);
      expect((await request("POST", "/courses", course)).status).toBe(403);
    }
  });

  it("deleting belongs to administration: the supervisor cannot", async () => {
    like(SUPERVISOR);
    expect((await request("DELETE", "/courses/c2")).status).toBe(403);
    like(ACADEMY_ADMIN);
    expect((await request("DELETE", "/courses/c2")).status).toBe(200);
  });

  it("nobody promotes themselves", async () => {
    like(ANA);
    expect((await request("PUT", "/profiles/u-ana/role", { role: "administrator" })).status).toBe(403);
    like(SUPERVISOR);
    expect((await request("PUT", "/profiles/u-super/role", { role: "administrator" })).status).toBe(
      403
    );
    const r = await client.query<{ training_role: string }>(
      "SELECT training_role FROM training_user_profiles WHERE user_id IN ('u-ana','u-super') ORDER BY user_id"
    );
    expect(r.rows.map((x) => x.training_role)).toEqual(["student", "supervisor"]);
  });

  it("a deactivated profile does not keep the role", async () => {
    await client.exec(
      "UPDATE training_user_profiles SET active = false WHERE user_id = 'u-super'"
    );
    like(SUPERVISOR);
    expect((await request("POST", "/courses", course)).status).toBe(403);
  });
});

describe("certificates", () => {
  it("the code is unpredictable and passes its own validator", async () => {
    await client.exec(
      "INSERT INTO course_progress (id, user_id, course_id, completed, survey_completed, completed_at) " +
        "VALUES ('pc1', 'u-ana', 'c1', true, true, now())"
    );
    like(ANA);
    const resp = await request("GET", "/certificates/c1");
    expect(resp.status).toBe(200);
    const { certificate } = await resp.json();
    expect(validateCertificateCode(certificate.code)).toBe(true);
    expect(certificate.code).not.toContain("c1");
    // And someone else's is not generated in their name.
    like(BEA);
    expect((await request("GET", "/certificates/c1")).status).toBe(403);
  });

  it("a course that does not exist is 404, not an authorization 403 (phase D)", async () => {
    like(ANA);
    expect((await request("GET", "/certificates/no-existe")).status).toBe(404);
    expect((await request("GET", "/certificates/no-existe/pdf")).status).toBe(404);
  });
});

/**
 * Phase D (authorization matrix): `PUT` with an empty body on tables without
 * `updatedAt` reached `.set({})` and drizzle threw "No values to set" → 500.
 */
describe("PUT without fields", () => {
  it("is a 400, not a 500", async () => {
    like(ADMIN);
    for (const route of ["/questions/p1", "/options/o1", "/assignments/a1"]) {
      expect((await request("PUT", route, {})).status, route).toBe(400);
    }
  });
});
