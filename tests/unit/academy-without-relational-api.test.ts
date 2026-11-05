/**
 * kon-academy-lms — the student flow with the HOST's Drizzle instance
 * ============================================================================
 *
 * Phase D (2026-10-25), over HTTP against the real API: almost the whole kon returned 500
 *
 *     undefined is not an object (evaluating 'dbInstance.query.courseProgressTable.findFirst')
 *
 * because the routes used `db.query.<table>` (Drizzle's relational API),
 * which only exists for the schema the instance was created with. The host's
 * does not carry this kon's (the core does not merge it: the kon is migrated
 * with its SQL), and the kon does not declare `relations()` either. The other tests
 * did not see it because they mount the kon with `drizzle(client, { schema })` — the
 * kon's own schema —, which is exactly what does not happen in production.
 *
 * Here the instance is `drizzle(client)`, WITHOUT a schema, like the host's
 * for this kon. And also: verifying a certificate is public (a
 * third party does it with the code), but the router-wide `requireAuth` gave it 401.
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
import { registerAcademyPolicy } from "../../kons/kon-academy-lms/academy.policy";

const here = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(here, "../../kons/kon-academy-lms/migrations");

let client: PGlite;
let app: Hono;
let session: { id: string; role: string; name?: string } | null = null;

const ADMIN = { id: "u-admin", role: "admin", name: "Admin" };
const ANA = { id: "u-ana", role: "user", name: "Ana" };
const BEA = { id: "u-bea", role: "user", name: "Bea" };

beforeAll(async () => {
  client = await PGlite.create();
  for (const f of ["0000_initial.sql", "0001_media_references.sql", "0002_unique_indexes.sql", "0006_english_names.sql", "0008_english_survey_columns.sql"]) {
    await client.exec(readFileSync(resolve(MIG, f), "utf8"));
  }
  registerAcademyPolicy();
  const ctx = createTestKonContext({
    db: {
      // WITHOUT `{ schema }`: this is how the kon sees the host's instance.
      instance: drizzle(client),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- double
      requireRole: () => (c: any) => c.json({ error: "the host's requireRole" }, 418),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- partial overrides
  } as any);
  app = new Hono();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: String((err as Error)?.message ?? err) }, 500);
  });
  app.route("/api/academy", createAcademyLMSRoutes(ctx));
});

afterAll(async () => {
  await client?.close();
});

beforeEach(() => {
  registerAcademyPolicy();
});

async function request(
  who: typeof ADMIN | null,
  method: string,
  route: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  session = who;
  const res = await app.request(`/api/academy${route}`, {
    method: method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* PDF or other binary */
  }
  return { status: res.status, json };
}

const ids: Record<string, string> = {};

describe("the course end to end", () => {
  it("the admin builds course → module → topic → quiz → question → options", async () => {
    const course = await request(ADMIN, "POST", "/courses", { title: "Seguridad", description: "x" });
    expect(course.status).toBe(201);
    ids.course = course.json.course.id;
    const mod = await request(ADMIN, "POST", "/modules", { courseId: ids.course, title: "M1" });
    expect(mod.status).toBe(201);
    ids.module = mod.json.module.id;
    const topic = await request(ADMIN, "POST", "/topics", {
      moduleId: ids.module,
      title: "T1",
      content: "<p>hola</p>",
    });
    expect(topic.status).toBe(201);
    ids.topic = topic.json.topic.id;
    // Creating the quiz used to look at `db.query.quizTable` first (500).
    const quiz = await request(ADMIN, "POST", "/quizzes", { moduleId: ids.module, title: "Q1" });
    expect(quiz.status).toBe(201);
    ids.quiz = quiz.json.quiz.id;
    const question = await request(ADMIN, "POST", `/quizzes/${ids.quiz}/questions`, { text: "¿2+2?" });
    expect(question.status).toBe(201);
    ids.question = question.json.question.id;
    const good = await request(ADMIN, "POST", `/questions/${ids.question}/options`, {
      text: "4",
      isCorrect: true,
    });
    expect(good.status).toBe(201);
    ids.good = good.json.option.id;
    expect((await request(ADMIN, "POST", `/questions/${ids.question}/options`, { text: "5" })).status).toBe(201);
    expect((await request(ADMIN, "POST", "/profiles", { userId: ANA.id })).status).toBe(201);
    const assign = await request(ADMIN, "POST", "/assignments", { courseId: ids.course, userId: ANA.id });
    expect(assign.status).toBe(201);
    ids.assignment = assign.json.assignment.id;
  });

  it("the student sees her course, opens it, completes the topic and passes the quiz", async () => {
    const list = await request(ANA, "GET", "/courses");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).toContain(ids.course);
    const detail = await request(ANA, "GET", `/courses/${ids.course}`);
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.json)).not.toContain("isCorrect");
    expect((await request(ANA, "GET", `/topics/${ids.topic}`)).status).toBe(200);
    expect((await request(ANA, "POST", `/topics/${ids.topic}/complete`)).status).toBe(200);
    const resp = await request(ANA, "POST", `/quizzes/${ids.quiz}/answer`, {
      answers: { [ids.question]: ids.good },
    });
    expect(resp.status).toBe(200);
    expect(JSON.stringify(resp.json)).toContain("true");
  });

  it("my-progress responds (before 500) and only with her own data", async () => {
    const ana = await request(ANA, "GET", "/dashboard/my-progress");
    expect(ana.status).toBe(200);
    expect(ana.json.totalAssigned).toBe(1);
    expect(ana.json.courses[0].course.modules[0].topics).toHaveLength(1);
    const bea = await request(BEA, "GET", "/dashboard/my-progress");
    expect(bea.status).toBe(200);
    expect(bea.json.totalAssigned).toBe(0);
  });

  it("survey → certificate → public verification without a session", async () => {
    const enc = await request(ANA, "POST", "/surveys", {
      courseId: ids.course,
      department: "TECHNOLOGY",
      jobTitle: "Analyst",
      presenter: 5,
      usefulness: true,
      satisfaction: 5,
      learned: "mucho",
      place: "HOME",
      role: "Participant",
      courseComments: "bien",
    });
    expect(enc.status).toBe(201);
    ids.survey = enc.json.survey?.id ?? enc.json.id;
    const cert = await request(ANA, "GET", `/certificates/${ids.course}`);
    expect(cert.status).toBe(200);
    const code = cert.json.certificate?.code ?? cert.json.code;
    expect(code).toMatch(/^CERT-/);
    const view = await request(null, "GET", `/certificates/verify/${code}`);
    expect(view.status).toBe(200);
    expect(view.json.valid).toBe(true);
    expect(view.json.certificate.course).toBe("Seguridad");
    // Everything else still asks for a session.
    expect((await request(null, "GET", "/courses")).status).toBe(401);
  });

  it("learning path: assign and mine (before 500)", async () => {
    const lp = await request(ADMIN, "POST", "/learning-paths", {
      name: "Ruta",
      courses: [{ courseId: ids.course, position: 1 }],
    });
    expect(lp.status).toBe(201);
    ids.lp = lp.json.learningPath.id;
    expect((await request(ADMIN, "POST", `/learning-paths/${ids.lp}/assign`, { userIds: [ANA.id] })).status).toBe(201);
    const my = await request(ANA, "GET", "/learning-paths/mine");
    expect(my.status).toBe(200);
    expect(my.json.total).toBe(1);
    expect(my.json.learningPaths[0].learningPath.name).toBe("Ruta");
    expect((await request(ANA, "GET", `/learning-paths/${ids.lp}`)).status).toBe(200);
  });

  it("the management views that gave 500: surveys/:id, assignments/:id, reports/users/:id", async () => {
    const enc = await request(ADMIN, "GET", `/surveys/${ids.survey}`);
    expect(enc.status).toBe(200);
    expect(enc.json.survey.course.title).toBe("Seguridad");
    const assign = await request(ADMIN, "GET", `/assignments/${ids.assignment}`);
    expect(assign.status).toBe(200);
    expect(assign.json.assignment.course.id).toBe(ids.course);
    const rep = await request(ADMIN, "GET", `/reports/users/${ANA.id}`);
    expect(rep.status).toBe(200);
    expect(rep.json.summary.totalAssignedCourses).toBe(1);
    expect(rep.json.summary.assignedLearningPaths).toBe(1);
    expect(rep.json.summary.totalCertificates).toBe(1);
    // And they are still management-only.
    expect((await request(BEA, "GET", `/reports/users/${ANA.id}`)).status).toBe(403);
  });
});
