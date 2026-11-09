/**
 * Academy LMS - API Routes (DI Version)
 *
 * Endpoints to manage courses, progress, quizzes, assignments, learning paths and more.
 *
 * MIGRATED: Now uses Dependency Injection via KonContext
 * - db → ctx.dbInstance.instance
 * - auth → ctx.auth.requireAuth, ctx.auth.requireRole
 *
 * FEATURES:
 * - Full CRUD for Courses, Modules, Topics, Quizzes, Questions, Options
 * - Progress tracking at course, module, and topic level
 * - Learning Paths with sequential approval support
 * - Group-based and individual assignments
 * - Satisfaction surveys and feedback
 * - Certificates generation
 * - Comprehensive reports and analytics
 */

import { randomBytes } from "node:crypto";

import {
  can,
  withSavepoint,
  requireUser,
  operationsRouter,
  type KonRouteContext,
  type AnyOperation,
} from "@kitsuden/engine";
import type { KonContext } from "@kitsuden/shared";
import { eq, and, desc, asc, inArray, sql, count, avg, sum, gt } from "drizzle-orm";
import type { Hono, MiddlewareHandler } from "hono";
import { z } from "zod";

// Importing it registers the "academy" and "academy-course" policies (deny-by-default).
import {
  administersAcademy,
  agentManagesAcademy,
  managesAcademy,
  type AcademyActor,
  type AcademyRole,
} from "./academy.policy";

import {
  // Tables
  userProfileTable,
  courseTable,
  assignmentGroupTable,
  groupUserTable,
  groupSupervisorTable,
  moduleTable,
  topicTable,
  additionalFileTable,
  quizTable,
  questionTable,
  optionTable,
  courseProgressTable,
  topicProgressTable,
  quizResultTable,
  userAnswerTable,
  assignmentTable,
  feedbackTable,
  satisfactionSurveyTable,
  certificateTable,
  // Learning Paths
  learningPathTable,
  learningPathCourseTable,
  learningPathProgressTable,
  learningPathAssignmentTable,
  // Enums
  courseTypeEnum,
  trainingRoleEnum,
  departmentEnum,
  jobTitleEnum,
  placeEnum,
  surveyRoleEnum,
  activityLogTable,
} from "./academy-lms.schema";
import type {
  Assignment,
  Course,
  SatisfactionSurvey,
  LearningPath,
  Module,
  CourseProgress,
  Quiz,
  Topic,
} from "./academy-lms.schema";
import { withRelation, first, all } from "./academy.queries";
import type { AcademyDb } from "./academy.db";
import {
  Row,
  Done,
  Obj,
  CodeParam,
  CourseParam,
  GroupAndSupervisorParam,
  GroupAndUserParam,
  ParamId,
  PathAndCourseParam,
  XLSX_TYPE,
  withRow,
  query,
  listing,
  text,
} from "./schemas";
import {
  ADMINISTER,
  ANY_ACCOUNT,
  MANAGE,
  KON_ID,
  inSeries,
  registry,
  validatedAsBefore,
} from "./operations";

// Services imports (moved to top level)
import {
  generateAssignmentsExcel,
  generateProgressExcel,
  generateSurveysExcel,
} from "./services/excel.service";
import {
  validateFile,
  determineMediaType,
  formatBytes,
  extractYoutubeInfo,
  normalizeVideoUrl,
} from "./services/media.service";
import {
  generateCertificatePdf,
  validateCertificateCode,
  type CertificateData,
} from "./services/pdf.service";
import {
  validateExternalUsers,
  parseCsv,
  exampleRoleMapping,
  syncConfigSchema,
  syncUsers,
  type SyncConfig,
  type SyncStore,
} from "./services/user-sync.service";

/**
 * The relational query without declared `relations()` types nested `with`
 * as an object|array union; at runtime the one-to-one relation is an object.
 * One assertion here and the call sites stay typed. Once the schema
 * declares its relations, this goes away.
 */
function moduleOfTopic(topic: { module: unknown }): { id: string; course: { id: string } } {
  return topic.module as { id: string; course: { id: string } };
}

/** What `POST /sync/users` receives. The shape of each user is given by its 400. */
const SyncUsers = z
  .object({
    users: z
      .array(z.unknown())
      .optional()
      .describe("External users: { externalId, email, name, lastName?, department?, jobTitle?… }"),
    config: z
      .unknown()
      .optional()
      .describe(
        "Sync options: { createNewUsers?, updateExisting?, roleMapping?: { externalField, values, default } }"
      ),
  })
  .passthrough()
  .optional();

/** What `POST /media/validate` receives: the file's metadata, not the file. */
const ValidateFile = z
  .object({
    fileName: z.string().optional(),
    fileSize: z.number().nonnegative().describe("Size in bytes"),
    mimeType: z.string().describe("MIME type, e.g. image/png"),
    type: z
      .enum(["image", "video", "document", "audio", "any"])
      .optional()
      .describe("Kind of file whose limits apply (default any)"),
  })
  .passthrough();

/** What the two video URL routes receive. The 400 for a missing URL comes from the handler. */
const WithUrl = z
  .object({ url: z.string().optional().describe("Video URL (max 2000 characters)") })
  .passthrough()
  .optional();

/**
 * The academy's operations (docs/kons/README.md). Each route keeps its
 * path, its order and its handler; what used to be middlewares
 * (`requireAuth` for the whole router, `requireRole`, `zValidator`) is now
 * the declaration: `access`, `permission` and `input`.
 */
export function academyOperations(ctx: KonContext): AnyOperation[] {
  const app = registry();
  const { db } = ctx;

  // Helper to get db instance
  const dbInstance = db.instance as AcademyDb;
  /** As the system, inside the request's RLS transaction (see KonDatabase). */
  const asSystem = db.asSystem ?? (<T>(fn: () => Promise<T>) => fn());

  // ============================================
  // AUTHORIZATION (academy.policy.ts)
  // ============================================

  /** Role in the academy, only if the profile exists and is active. */
  async function academyRoleOf(userId: string): Promise<AcademyRole | null> {
    const [profile] = await dbInstance
      .select({
        role: userProfileTable.trainingRole,
        active: userProfileTable.active,
      })
      .from(userProfileTable)
      .where(eq(userProfileTable.userId, userId))
      .limit(1);
    return profile?.active ? profile.role : null;
  }

  /** The session user with their academy role. 401 if there is no session. */
  async function actorOf(c: KonRouteContext): Promise<AcademyActor> {
    const user = requireUser(c);
    return { ...user, academyRole: await academyRoleOf(user.id) } as AcademyActor;
  }

  /**
   * Since 2026-10-25 (audit) course content and group members are
   * admin-only: they are global and the supervisor was changing them for
   * everyone. The supervisor manages THEIR groups (assignments and the data
   * of their students, see `outsideTheirGroups` and migration 0004).
   *
   * This used to be a custom `requireRole(roles)` (the host's looked at the
   * GLOBAL role: nobody is a "supervisor" there, so everything returned 403,
   * even for the admin). Now it is each operation's `permission` —`MANAGE`
   * where the list included "supervisor", `ADMINISTER` where it did not— and
   * the SDK checks it before reading the body, as before.
   *
   * What the policy needs is the role IN THE ACADEMY, which is not in the
   * session: this middleware (the operation's `before`, which runs after
   * authentication and before the permission) adds it to the request's user.
   */
  const withAcademyRole: MiddlewareHandler = async (c, next) => {
    const user = (c.get as (k: string) => unknown)("user") as { id?: string } | undefined;
    if (user?.id) {
      (c.set as (k: string, v: unknown) => void)("user", {
        ...user,
        academyRole: await academyRoleOf(user.id),
      });
    }
    await next();
  };

  /**
   * Can this actor assign these students and groups? The admin, anyone; the
   * supervisor, only the students and groups they supervise (audit
   * 2026-10-25: they used to assign anyone). The rule lives in Postgres
   * (`academy_supervises_*`, migration 0004) so the application and RLS say
   * the same thing. Returns the rejection reason, or `null`.
   */
  async function outsideTheirGroups(
    actor: AcademyActor,
    target: { userIds?: (string | null | undefined)[]; groupIds?: (string | null | undefined)[] }
  ): Promise<string | null> {
    // A managing agent has no groups: its scope covers every learner (academy.policy.ts).
    if (administersAcademy(actor) || agentManagesAcademy(actor)) return null;
    for (const groupId of target.groupIds ?? []) {
      if (!groupId) continue;
      const r = (await dbInstance.execute(
        sql`SELECT academy_supervises_group(${groupId}) AS ok`
      )) as unknown as {
        rows: { ok: boolean }[];
      };
      if (!r.rows[0]?.ok) return "You can only assign to groups you supervise";
    }
    for (const userId of target.userIds ?? []) {
      if (!userId) continue;
      const r = (await dbInstance.execute(
        sql`SELECT academy_supervises_user(${userId}) AS ok`
      )) as unknown as {
        rows: { ok: boolean }[];
      };
      if (!r.rows[0]?.ok) return "You can only assign to students of the groups you supervise";
    }
    return null;
  }

  /** Courses assigned to the user: directly or through their groups. */
  async function assignedCourses(userId: string): Promise<string[]> {
    const direct = await dbInstance
      .select({ courseId: assignmentTable.courseId })
      .from(assignmentTable)
      .where(eq(assignmentTable.userId, userId));
    const byGroup = await dbInstance
      .select({ courseId: assignmentTable.courseId })
      .from(assignmentTable)
      .innerJoin(groupUserTable, eq(groupUserTable.groupId, assignmentTable.groupId))
      .where(eq(groupUserTable.userId, userId));
    return [...new Set([...direct, ...byGroup].map((a) => a.courseId))];
  }

  async function assignedToCourse(userId: string, courseId: string): Promise<boolean> {
    return (await assignedCourses(userId)).includes(courseId);
  }

  /**
   * Can this actor see the course content? Whoever manages it, yes; a
   * student, only if assigned and the course is active. The routes answer 404
   * rather than 403: whether a course exists is none of the business of whoever does not have it.
   */
  async function canViewCourse(
    actor: AcademyActor,
    course: { id: string; active?: boolean | null }
  ): Promise<boolean> {
    const assigned = managesAcademy(actor) || (await assignedToCourse(actor.id!, course.id));
    return can(
      actor,
      "view",
      { id: course.id, assigned, active: course.active ?? true },
      "academy-course"
    );
  }

  /**
   * A student's progress in a course: completed active topics + passed active
   * quizzes over the total. Complete when nothing is missing.
   *
   * Nobody used to compute it (phase D, 2026-10-25): completing a topic left
   * the row with `progressPercent: 0` and `completed` never became
   * `true`, so the survey ("You must complete the course") and the certificate
   * were unreachable for any student.
   */
  async function recalculateCourseProgress(userId: string, courseId: string): Promise<void> {
    const modules = (await all(dbInstance, moduleTable, eq(moduleTable.courseId, courseId))).filter(
      (m) => m.active
    );
    const moduleIds = modules.map((m) => m.id);
    const topicIds = moduleIds.length
      ? (await all(dbInstance, topicTable, inArray(topicTable.moduleId, moduleIds)))
          .filter((t) => t.active)
          .map((t) => t.id)
      : [];
    const quizIds = moduleIds.length
      ? (await all(dbInstance, quizTable, inArray(quizTable.moduleId, moduleIds)))
          .filter((q) => q.active)
          .map((q) => q.id)
      : [];
    const doneTopics = topicIds.length
      ? (
          await all(
            dbInstance,
            topicProgressTable,
            and(
              eq(topicProgressTable.userId, userId),
              inArray(topicProgressTable.topicId, topicIds),
              eq(topicProgressTable.completed, true)
            )
          )
        ).length
      : 0;
    const passedQuizzes = quizIds.length
      ? new Set(
          (
            await all(
              dbInstance,
              quizResultTable,
              and(
                eq(quizResultTable.userId, userId),
                inArray(quizResultTable.quizId, quizIds),
                eq(quizResultTable.passed, true)
              )
            )
          ).map((r) => r.quizId)
        ).size
      : 0;
    const total = topicIds.length + quizIds.length;
    const facts = doneTopics + passedQuizzes;
    const progressPercentage = total > 0 ? Math.round((facts / total) * 100) : 0;
    const completed = total > 0 && facts >= total;
    const now = new Date();
    await dbInstance
      .insert(courseProgressTable)
      .values({
        userId,
        courseId,
        progressPercent: progressPercentage,
        completed,
        completedAt: completed ? now : null,
      })
      .onConflictDoUpdate({
        target: [courseProgressTable.userId, courseProgressTable.courseId],
        set: {
          progressPercent: progressPercentage,
          completed,
          // The first time it is completed; not overwritten on recalculation.
          completedAt: completed
            ? sql`coalesce(${courseProgressTable.completedAt}, now())`
            : null,
          updatedAt: now,
        },
      });
  }

  /** Course of a module / topic / quiz, with a single query. */
  async function courseOfModule(moduleId: string) {
    const [row] = await dbInstance
      .select({ id: courseTable.id, active: courseTable.active, moduleActive: moduleTable.active })
      .from(moduleTable)
      .innerJoin(courseTable, eq(courseTable.id, moduleTable.courseId))
      .where(eq(moduleTable.id, moduleId))
      .limit(1);
    return row ?? null;
  }

  /** An option as a student sees it: WITHOUT `isCorrect`. */
  const withoutSolution = (o: typeof optionTable.$inferSelect) => ({
    id: o.id,
    questionId: o.questionId,
    text: o.text,
    position: o.position,
  });

  /**
   * Modules → topics (+files) → quiz → questions → options of a course, with
   * flat queries (the schema does not declare `relations()`, so the `with`
   * of `db.query` does not work).
   *
   * `forTeam = false` is the STUDENT view: no drafts (`active`
   * false) and no `isCorrect` in the options — a quiz's answers
   * do not leave the server before it is answered.
   */
  async function courseTree(courseId: string, forTeam: boolean, moduleOnly?: string) {
    const modules = (
      await dbInstance
        .select()
        .from(moduleTable)
        .where(
          moduleOnly
            ? and(eq(moduleTable.courseId, courseId), eq(moduleTable.id, moduleOnly))
            : eq(moduleTable.courseId, courseId)
        )
        .orderBy(asc(moduleTable.position))
    ).filter((m: Module) => forTeam || m.active);
    const moduleIds = modules.map((m: Module) => m.id);

    const topics = moduleIds.length
      ? (
          await dbInstance
            .select()
            .from(topicTable)
            .where(inArray(topicTable.moduleId, moduleIds))
            .orderBy(asc(topicTable.position))
        ).filter((t: Topic) => forTeam || t.active)
      : [];
    const topicIds = topics.map((t: Topic) => t.id);
    const files = topicIds.length
      ? await dbInstance
          .select()
          .from(additionalFileTable)
          .where(inArray(additionalFileTable.topicId, topicIds))
          .orderBy(asc(additionalFileTable.position))
      : [];

    const quizzes = moduleIds.length
      ? (
          await dbInstance.select().from(quizTable).where(inArray(quizTable.moduleId, moduleIds))
        ).filter((q: Quiz) => forTeam || q.active)
      : [];
    const quizIds = quizzes.map((q: Quiz) => q.id);
    const questions = quizIds.length
      ? (
          await dbInstance
            .select()
            .from(questionTable)
            .where(inArray(questionTable.quizId, quizIds))
            .orderBy(asc(questionTable.position))
        ).filter((p: typeof questionTable.$inferSelect) => forTeam || p.active)
      : [];
    const questionIds = questions.map((p: typeof questionTable.$inferSelect) => p.id);
    const options = questionIds.length
      ? await dbInstance
          .select()
          .from(optionTable)
          .where(inArray(optionTable.questionId, questionIds))
          .orderBy(asc(optionTable.position))
      : [];

    return modules.map((m: Module) => {
      const quiz = quizzes.find((q: Quiz) => q.moduleId === m.id);
      return {
        ...m,
        topics: topics
          .filter((t: Topic) => t.moduleId === m.id)
          .map((t: Topic) => ({
            ...t,
            files: files.filter(
              (a: typeof additionalFileTable.$inferSelect) => a.topicId === t.id
            ),
          })),
        quiz: quiz
          ? {
              ...quiz,
              questions: questions
                .filter((p: typeof questionTable.$inferSelect) => p.quizId === quiz.id)
                .map((p: typeof questionTable.$inferSelect) => ({
                  ...p,
                  options: options
                    .filter((o: typeof optionTable.$inferSelect) => o.questionId === p.id)
                    .map((o: typeof optionTable.$inferSelect) => (forTeam ? o : withoutSolution(o))),
                })),
            }
          : null,
      };
    });
  }

  /** Unpredictable certificate code (before: id prefixes + clock). */
  const certificateCode = () => {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const chunk = (n: number) =>
      Array.from(randomBytes(n), (b) => alphabet[b % alphabet.length]).join("");
    return `CERT-${chunk(8)}-${chunk(8)}-${chunk(12)}`;
  };

  // ============================================
  // ACCESS
  // ============================================

  // Everything requires a session (`access: "session"`) EXCEPT verifying a certificate
  // (`access: "public"`): it is done by whoever receives the code (a company, a
  // third party), not its owner (see the route). It used to be a `requireAuth` for the whole
  // router with that exception, and without it the public route answered 401 to
  // anyone without an account in THIS installation (phase D, 2026-10-25).

  // ============================================
  // COURSES
  // ============================================

  /**
   * GET /courses
   * Lists all the courses available to the authenticated user
   */
  app.get(
    "/courses",
    {
      id: "list-my-courses",
      summary: "List my assigned courses",
      description:
        "Active courses assigned to you (directly or through one of your groups), each with its modules and topics (no quizzes), your progress percentage, and whether you completed it and its survey. Filter with status. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: {
        query: query({
          status: text("all (default) | not-started | in-progress | completed"),
        }),
      },
      output: { schema: listing("courses") },
    },
    async (c) => {
      const user = requireUser(c);
      const status = c.req.query("status") || "all"; // all, not-started, in-progress, completed

      // Courses assigned to the user (directly or by group), active only.
      const coursesIds = await assignedCourses(user.id);
      if (coursesIds.length === 0) {
        return c.json({ courses: [], total: 0 });
      }
      const courses = await dbInstance
        .select()
        .from(courseTable)
        .where(and(inArray(courseTable.id, coursesIds), eq(courseTable.active, true)));

      const coursesWithProgress = await inSeries(courses, async (course: Course) => {
        const modules = await courseTree(course.id, false);
        const progress = await first(
          dbInstance,
          courseProgressTable,
          and(eq(courseProgressTable.userId, user.id), eq(courseProgressTable.courseId, course.id))
        );
        const topicIds = modules.flatMap((m) => m.topics.map((t) => t.id));
        const [{ count: completedItems }] = topicIds.length
          ? await dbInstance
              .select({ count: count() })
              .from(topicProgressTable)
              .where(
                and(
                  eq(topicProgressTable.userId, user.id),
                  inArray(topicProgressTable.topicId, topicIds)
                )
              )
          : [{ count: 0 }];
        const percentage =
          topicIds.length > 0 ? Math.round((Number(completedItems) / topicIds.length) * 100) : 0;

        // The listing carries no quizzes: questions or options are not needed
        // to draw a course card.
        return {
          ...course,
          modules: modules.map(({ quiz: _q, ...m }) => m),
          progressPercent: percentage,
          completed: progress?.completed || false,
          surveyCompleted: progress?.surveyCompleted || false,
        };
      });

      let filteredCourses = coursesWithProgress;
      if (status === "not-started") {
        filteredCourses = coursesWithProgress.filter((c) => c.progressPercent === 0);
      } else if (status === "in-progress") {
        filteredCourses = coursesWithProgress.filter(
          (c) => c.progressPercent > 0 && c.progressPercent < 100
        );
      } else if (status === "completed") {
        filteredCourses = coursesWithProgress.filter((c) => c.progressPercent === 100);
      }

      return c.json({
        courses: filteredCourses,
        total: filteredCourses.length,
        status,
      });
    }
  );

  /**
   * GET /courses/:id
   * Full detail of a course including modules, topics and progress
   */
  app.get(
    "/courses/:id",
    {
      id: "get-course",
      summary: "Course detail",
      description:
        "A course with its modules, topics, files and quiz, plus your progress (completed topic ids, passed quizzes). Students only see active content and never which option is correct; a course you are not assigned to is a 404. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Course id") },
      output: { schema: z.object({ course: Row, progress: Obj }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const courseId = c.req.param("id");

      const [course] = await dbInstance
        .select()
        .from(courseTable)
        .where(eq(courseTable.id, courseId))
        .limit(1);
      // 404 both if it does not exist and if it is not theirs: what exists is not confirmed.
      if (!course || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Course not found" }, 404);
      }

      const forTeam = managesAcademy(actor);
      const modules = await courseTree(courseId, forTeam);

      const progress = await first(
        dbInstance,
        courseProgressTable,
        and(eq(courseProgressTable.userId, actor.id!), eq(courseProgressTable.courseId, courseId))
      );

      const topicsIds = modules.flatMap((m) => m.topics.map((t) => t.id));
      const topicsProgress = topicsIds.length
        ? await all(
            dbInstance,
            topicProgressTable,
            and(
              eq(topicProgressTable.userId, actor.id!),
              inArray(topicProgressTable.topicId, topicsIds)
            )
          )
        : [];
      const completedTopicIds = topicsProgress.filter((p) => p.completed).map((p) => p.topicId);

      const quizzesIds = modules.map((m) => m.quiz?.id).filter((x): x is string => Boolean(x));
      const quizResults = quizzesIds.length
        ? await all(
            dbInstance,
            quizResultTable,
            and(
              eq(quizResultTable.userId, actor.id!),
              inArray(quizResultTable.quizId, quizzesIds)
            )
          )
        : [];

      return c.json({
        course: { ...course, modules },
        progress: {
          ...progress,
          completedTopicIds,
          passedQuizzes: quizResults.filter((r) => r.passed).length,
        },
      });
    }
  );

  /**
   * POST /courses (Admin/Supervisor)
   * Create a new course
   */
  const createCourseSchema = z.object({
    title: z.string().min(1),
    description: z.string().min(1),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    durationHours: z.number().positive().optional(),
    coverColor: z.string().default("#009c3c"),
    courseType: z.enum(courseTypeEnum.enumValues).optional(),
  });

  app.post(
    "/courses",
    {
      id: "create-course",
      summary: "Create a course",
      description:
        "Creates a course (title, description, dates, hours, cover colour, type). Returns the new row. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createCourseSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("course") },
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createCourseSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      const [course] = await dbInstance
        .insert(courseTable)
        .values({
          ...data,
          startDate: data.startDate ? new Date(data.startDate) : null,
          endDate: data.endDate ? new Date(data.endDate) : null,
          // decimal() in drizzle is string in TS; the driver coerced the
          // number silently, but the insert contract is string.
          durationHours: data.durationHours?.toString(),
        })
        .returning();

      return c.json({ success: true, course }, 201);
    }
  );

  // ============================================
  // TOPICS AND PROGRESS
  // ============================================

  /**
   * GET /topics/:id
   * View the detail of a topic
   */
  app.get(
    "/topics/:id",
    {
      id: "get-topic",
      summary: "Topic detail",
      description:
        "A topic with its extra files, whether you completed it and its last 5 feedback entries (anonymous; `yours` marks yours). A topic of a course you are not assigned to is a 404. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Topic id") },
      output: {
        schema: z
          .object({ topic: Row, completed: z.boolean(), feedbacks: z.array(Obj) })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const topicId = c.req.param("id");

      const [topic] = await dbInstance
        .select()
        .from(topicTable)
        .where(eq(topicTable.id, topicId))
        .limit(1);
      const course = topic ? await courseOfModule(topic.moduleId) : null;
      if (!topic || !course || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Topic not found" }, 404);
      }
      if (!managesAcademy(actor) && (!topic.active || !course.moduleActive)) {
        return c.json({ error: "Topic not found" }, 404);
      }

      const files = await dbInstance
        .select()
        .from(additionalFileTable)
        .where(eq(additionalFileTable.topicId, topicId))
        .orderBy(asc(additionalFileTable.position));

      const progress = await first(
        dbInstance,
        topicProgressTable,
        and(eq(topicProgressTable.userId, actor.id!), eq(topicProgressTable.topicId, topicId))
      );

      // Feedback entries of the topic (last 5). It used to go with `user: true`: the row of
      // the account of every student who had given an opinion. Now only the opinion, and whether
      // it is yours.
      const feedbacks = (
        await dbInstance
          .select()
          .from(feedbackTable)
          .where(eq(feedbackTable.topicId, topicId))
          .orderBy(desc(feedbackTable.createdAt))
          .limit(5)
      ).map((f: typeof feedbackTable.$inferSelect) => ({
        id: f.id,
        rating: f.rating,
        comment: f.comment,
        createdAt: f.createdAt,
        yours: f.userId === actor.id,
      }));

      return c.json({
        topic: { ...topic, files },
        completed: progress?.completed || false,
        feedbacks,
      });
    }
  );

  /**
   * POST /topics/:id/complete
   * Mark a topic as completed
   */
  app.post(
    "/topics/:id/complete",
    {
      id: "complete-topic",
      summary: "Mark a topic as completed",
      description:
        "Marks the topic as completed for you and recalculates your course progress. Returns whether the whole module is now completed. Only topics of courses assigned to you (404 otherwise). Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Topic id") },
      output: {
        schema: z
          .object({ success: z.literal(true), message: z.string(), moduleCompleted: z.boolean() })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      idempotent: true,
    },
    async (c) => {
      const actor = await actorOf(c);
      const user = { id: actor.id! };
      const topicId = c.req.param("id");

      const [row] = await dbInstance
        .select()
        .from(topicTable)
        .where(eq(topicTable.id, topicId))
        .limit(1);
      const courseOfTopic = row ? await courseOfModule(row.moduleId) : null;
      // Nothing used to be checked: any account completed topics (and
      // created progress) of courses it was not assigned to.
      if (!row || !courseOfTopic || !row.active || !(await canViewCourse(actor, courseOfTopic))) {
        return c.json({ error: "Topic not found" }, 404);
      }
      const topic = { ...row, module: { id: row.moduleId, course: { id: courseOfTopic.id } } };

      // Update or create progress
      await dbInstance
        .insert(topicProgressTable)
        .values({
          userId: user.id,
          topicId,
          completed: true,
          completedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [topicProgressTable.userId, topicProgressTable.topicId],
          set: {
            completed: true,
            completedAt: new Date(),
          },
        });

      // Check whether the module was completed
      const moduleTopicsTotal = await dbInstance
        .select({ count: count() })
        .from(topicTable)
        .where(eq(topicTable.moduleId, moduleOfTopic(topic).id));

      const moduleCompletedTopics = await dbInstance
        .select({ count: count() })
        .from(topicProgressTable)
        .where(
          and(
            eq(topicProgressTable.userId, user.id),
            inArray(
              topicProgressTable.topicId,
              dbInstance
                .select({ id: topicTable.id })
                .from(topicTable)
                .where(eq(topicTable.moduleId, moduleOfTopic(topic).id))
            ),
            eq(topicProgressTable.completed, true)
          )
        );

      // Update course progress
      await recalculateCourseProgress(user.id, moduleOfTopic(topic).course.id);

      return c.json({
        success: true,
        message: "Topic marked as completed",
        moduleCompleted: moduleCompletedTopics[0].count === moduleTopicsTotal[0].count,
      });
    }
  );

  // ============================================
  // QUIZZES
  // ============================================

  /**
   * POST /quizzes/:id/answer
   * Submit answers to a quiz
   */
  const answerQuizSchema = z
    .object({
      answers: z
        .record(z.string().max(64), z.string().max(64))
        .refine((r) => Object.keys(r).length <= 500, "Too many answers"), // { questionId: optionId }
      timeSpentSeconds: z.number().int().min(0).max(86_400).optional(),
    })
    .strict();

  /**
   * Attempts per quiz and student. Without a cap, each attempt returns the score and
   * answering one at a time lets the correct answers be deduced.
   */
  const MAX_QUIZ_ATTEMPTS = 5;

  app.post(
    "/quizzes/:id/answer",
    {
      id: "answer-quiz",
      summary: "Answer a quiz",
      description:
        "Submits your answers ({ questionId: optionId }) and returns your score, whether you passed and attempts left. Never returns the correct options. Max 5 attempts (429), a passed quiz cannot be retaken (409). Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Quiz id"), body: answerQuizSchema, validatesHandler: true },
      output: { schema: z.object({ success: z.literal(true), result: Obj }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND", "KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, answerQuizSchema, input.body);
      if (valid instanceof Response) return valid;
      const actor = await actorOf(c);
      const quizId = c.req.param("id");
      const { answers: responses, timeSpentSeconds } = valid;

      const [quiz] = await dbInstance
        .select()
        .from(quizTable)
        .where(eq(quizTable.id, quizId))
        .limit(1);
      const course = quiz ? await courseOfModule(quiz.moduleId) : null;
      // Before: the course was not checked. Any account answered any quiz.
      if (!quiz || !course || !quiz.active || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Quiz not found" }, 404);
      }

      // Lock per (user, quiz) until the end of the request (it lives in its
      // transaction): 50 parallel answers all saw "fewer than 5
      // attempts" and each returned the score (audit 2026-10-25).
      await dbInstance.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`academy:quiz:${actor.id}:${quizId}`}))`
      );

      const priors = await dbInstance
        .select({ passed: quizResultTable.passed })
        .from(quizResultTable)
        .where(
          and(eq(quizResultTable.userId, actor.id!), eq(quizResultTable.quizId, quizId))
        );
      if (priors.some((r: { passed: boolean }) => r.passed)) {
        return c.json({ error: "This quiz is already passed" }, 409);
      }
      if (priors.length >= MAX_QUIZ_ATTEMPTS) {
        return c.json({ error: "You have used up your attempts for this quiz" }, 429);
      }

      // ACTIVE questions of the quiz and their options, from the database.
      const questions = (
        await dbInstance.select().from(questionTable).where(eq(questionTable.quizId, quizId))
      ).filter((p: typeof questionTable.$inferSelect) => p.active);
      const options = questions.length
        ? await dbInstance
            .select()
            .from(optionTable)
            .where(
              inArray(
                optionTable.questionId,
                questions.map((p: typeof questionTable.$inferSelect) => p.id)
              )
            )
        : [];

      let totalScore = 0;
      let maxScore = 0;
      const answersDetail: Record<
        string,
        { selected: string | null; correct: string; isCorrect: boolean }
      > = {};

      for (const question of questions as (typeof questionTable.$inferSelect)[]) {
        maxScore += question.score;
        const theirOwn = options.filter(
          (o: typeof optionTable.$inferSelect) => o.questionId === question.id
        );
        const correctOption = theirOwn.find((o: typeof optionTable.$inferSelect) => o.isCorrect);
        // Only an option OF THIS question counts: an id from another question (or
        // from another quiz) is treated as unanswered.
        const chosen = theirOwn.find(
          (o: typeof optionTable.$inferSelect) => o.id === responses[question.id]
        );
        const hit = Boolean(correctOption && chosen && correctOption.id === chosen.id);

        answersDetail[question.id] = {
          selected: chosen?.id ?? null,
          correct: correctOption?.id || "",
          isCorrect: hit,
        };
        if (hit) totalScore += question.score;

        if (chosen) {
          await dbInstance
            .insert(userAnswerTable)
            .values({
              userId: actor.id!,
              questionId: question.id,
              selectedOptionId: chosen.id,
            })
            .onConflictDoNothing();
        }
      }

      const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
      const approved = maxScore > 0 && percentage >= quiz.minPassingScore;

      // `answersDetail` (with the correct one) is stored for the team; the
      // student only gets the score back.
      await dbInstance.insert(quizResultTable).values({
        userId: actor.id!,
        quizId,
        score: totalScore,
        scorePercent: percentage,
        passed: approved,
        answersJson: answersDetail,
        timeSpentSeconds,
      });
      if (approved) await recalculateCourseProgress(actor.id!, course.id);

      return c.json({
        success: true,
        result: {
          score: totalScore,
          maxScore,
          percent: percentage,
          passed: approved,
          minScore: quiz.minPassingScore,
          attemptsLeft: Math.max(0, MAX_QUIZ_ATTEMPTS - priors.length - 1),
        },
      });
    }
  );

  // ============================================
  // ASSIGNMENTS (Admin/Supervisor)
  // ============================================

  /**
   * POST /assignments
   * Assign a course to a user or group
   */
  const assignCourseSchema = z.object({
    courseId: z.string(),
    userId: z.string().optional(),
    groupId: z.string().optional(),
    notes: z.string().optional(),
  });

  /**
   * POST /assignments/multiple
   * Assign multiple courses to one or more users (BULK)
   */
  const assignMultipleSchema = z.object({
    courseIds: z.array(z.string()).min(1, "You must specify at least one course"),
    userIds: z.array(z.string()).optional(),
    groupIds: z.array(z.string()).optional(),
    dueDate: z.string().datetime().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    notes: z.string().optional(),
  });

  app.post(
    "/assignments",
    {
      id: "assign-course",
      summary: "Assign a course",
      description:
        "Assigns a course to one user (userId) or a group (groupId) and creates their progress rows. A supervisor may only assign to the users and groups they supervise (403). Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { body: assignCourseSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("assignment") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, assignCourseSchema, input.body);
      if (valid instanceof Response) return valid;
      const admin = requireUser(c);
      const data = valid;

      if (!data.userId && !data.groupId) {
        return c.json({ error: "You must specify userId or groupId" }, 400);
      }
      const outside = await outsideTheirGroups(await actorOf(c), {
        userIds: [data.userId],
        groupIds: [data.groupId],
      });
      if (outside) return c.json({ error: outside }, 403);

      // Create assignment
      const [assignment] = await dbInstance
        .insert(assignmentTable)
        .values({
          courseId: data.courseId,
          userId: data.userId,
          groupId: data.groupId,
          method: data.groupId ? "group" : "manual",
          assignedById: admin.id,
          notes: data.notes,
        })
        .returning();

      // If it is a group, create assignments and progress for each member
      if (data.groupId) {
        const members = await dbInstance
          .select({ userId: groupUserTable.userId })
          .from(groupUserTable)
          .where(eq(groupUserTable.groupId, data.groupId));

        for (const member of members) {
          await dbInstance
            .insert(courseProgressTable)
            .values({
              userId: member.userId,
              courseId: data.courseId,
            })
            .onConflictDoNothing();
        }
      } else if (data.userId) {
        // Create progress for an individual user
        await dbInstance
          .insert(courseProgressTable)
          .values({
            userId: data.userId,
            courseId: data.courseId,
          })
          .onConflictDoNothing();
      }

      return c.json({ success: true, assignment }, 201);
    }
  );

  /**
   * GET /assignments
   * List assignments with filters
   */
  app.get(
    "/assignments",
    {
      id: "list-assignments",
      summary: "List course assignments",
      description:
        "Course assignments, newest first, filtered by courseId, userId and/or groupId. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: {
        query: query({
          courseId: text("Course id"),
          userId: text("User id"),
          groupId: text("Group id"),
        }),
      },
      output: { schema: listing("assignments") },
    },
    async (c) => {
      const courseId = c.req.query("courseId");
      const userId = c.req.query("userId");
      const groupId = c.req.query("groupId");

      // Chaining .where() in drizzle REPLACES the previous one (the last wins):
      // filtering by course AND user only applied the user filter. With
      // `any` it compiled and silently returned extra rows. The
      // conditions are accumulated and applied once.
      const filters = [
        courseId ? eq(assignmentTable.courseId, courseId) : undefined,
        userId ? eq(assignmentTable.userId, userId) : undefined,
        groupId ? eq(assignmentTable.groupId, groupId) : undefined,
      ].filter((f) => f !== undefined);

      const assignments = await dbInstance
        .select()
        .from(assignmentTable)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(assignmentTable.date));

      // The panel reads `courseId`; the column keeps its name in the table and in the filters.
      return c.json({
        assignments: assignments.map((a: { courseId: string }) => ({ ...a, courseId: a.courseId })),
        total: assignments.length,
      });
    }
  );

  /**
   * POST /assignments/multiple
   * Assign multiple courses to one or more users
   */
  app.post(
    "/assignments/multiple",
    {
      id: "assign-courses-in-bulk",
      summary: "Assign several courses in bulk",
      description:
        "Assigns every course in courseIds to every user in userIds and every member of groupIds. Pairs that fail are reported in results.errors instead of failing the request. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { body: assignMultipleSchema, validatesHandler: true },
      output: {
        status: 201,
        schema: z
          .object({ success: z.literal(true), message: z.string(), results: Obj })
          .passthrough(),
      },
      sensitive: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, assignMultipleSchema, input.body);
      if (valid instanceof Response) return valid;
      const admin = requireUser(c);
      const data = valid;

      if (
        (!data.userIds || data.userIds.length === 0) &&
        (!data.groupIds || data.groupIds.length === 0)
      ) {
        return c.json({ error: "You must specify at least one userId or groupId" }, 400);
      }
      const outOfGroup = await outsideTheirGroups(await actorOf(c), {
        userIds: data.userIds,
        groupIds: data.groupIds,
      });
      if (outOfGroup) return c.json({ error: outOfGroup }, 403);

      const results = {
        assignmentsCreated: 0,
        progressesCreated: 0,
        assignedCourses: data.courseIds.length,
        assignedUsers: 0,
        errors: [] as string[],
      };

      // Get all target users (individual + from groups)
      const targetUsers = new Set<string>();

      if (data.userIds) {
        data.userIds.forEach((id) => targetUsers.add(id));
      }

      if (data.groupIds) {
        for (const groupId of data.groupIds) {
          const members = await dbInstance
            .select({ userId: groupUserTable.userId })
            .from(groupUserTable)
            .where(eq(groupUserTable.groupId, groupId));
          members.forEach((m: { userId: string }) => targetUsers.add(m.userId));
        }
      }

      results.assignedUsers = targetUsers.size;

      // Assign each course to each user
      for (const courseId of data.courseIds) {
        for (const userId of Array.from(targetUsers)) {
          try {
            // Each course-user pair in its SAVEPOINT: the request runs in a
            // transaction, and a failure here without it would leave it aborted for
            // all the following pairs (and Postgres would also undo the
            // previous ones on commit). This way only this pair fails.
            await withSavepoint(async () => {
              await dbInstance
                .insert(assignmentTable)
                .values({
                  courseId,
                  userId,
                  method: data.groupIds && data.groupIds.length > 0 ? "group" : "manual",
                  assignedById: admin.id,
                  notes: data.notes,
                })
                .onConflictDoNothing();
              await dbInstance
                .insert(courseProgressTable)
                .values({
                  userId,
                  courseId,
                })
                .onConflictDoNothing();
            });
            // Counted afterwards: if the savepoint is rolled back, none was created.
            results.assignmentsCreated++;
            results.progressesCreated++;
          } catch (error) {
            results.errors.push(`Error assigning course ${courseId} to user ${userId}`);
          }
        }
      }

      return c.json(
        {
          success: true,
          message: `Assigned ${results.assignedCourses} courses to ${results.assignedUsers} users`,
          results,
        },
        201
      );
    }
  );

  // ============================================
  // LEARNING PATHS
  // ============================================

  /**
   * GET /learning-paths
   * List all active learning paths
   */
  app.get(
    "/learning-paths",
    {
      id: "list-learning-paths",
      summary: "List learning paths",
      description:
        "Active learning paths (optionally by category), newest first, each with its number of courses. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { query: query({ category: text("Category") }) },
      output: { schema: listing("learningPaths") },
    },
    async (c) => {
      const category = c.req.query("category");

      // The second .where() OVERWROTE the first: with ?category= INACTIVE
      // learning paths were listed. Same chaining bug as in /assignments.
      const paths = await dbInstance
        .select()
        .from(learningPathTable)
        .where(
          category
            ? and(eq(learningPathTable.active, true), eq(learningPathTable.category, category))
            : eq(learningPathTable.active, true)
        )
        .orderBy(desc(learningPathTable.createdAt));

      // Count courses in each path
      const pathsWithCount = await inSeries(paths, async (path: LearningPath) => {
        const [countValue] = await dbInstance
          .select({ count: count() })
          .from(learningPathCourseTable)
          .where(eq(learningPathCourseTable.learningPathId, path.id));

        return {
          ...path,
          totalCourses: countValue.count,
        };
      });

      return c.json({ learningPaths: pathsWithCount, total: pathsWithCount.length });
    }
  );

  // Routes with a literal segment go before the sibling wildcard: with
  // `/learning-paths/:id` first, `mine` was read as an id.
  /**
   * GET /learning-paths/mine
   * Get the learning paths assigned to the authenticated user
   */
  app.get(
    "/learning-paths/mine",
    {
      id: "list-my-learning-paths",
      summary: "List my learning paths",
      description:
        "Your learning path progress rows, each with its learning path, plus how many are completed, in progress and pending. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      output: { schema: listing("learningPaths") },
    },
    async (c) => {
      const user = requireUser(c);

      const myPaths = await withRelation(
        dbInstance,
        await all(
          dbInstance,
          learningPathProgressTable,
          eq(learningPathProgressTable.userId, user.id),
          [desc(learningPathProgressTable.createdAt)]
        ),
        "learningPathId",
        learningPathTable,
        "learningPath"
      );

      return c.json({
        learningPaths: myPaths,
        total: myPaths.length,
        completedItems: myPaths.filter((p) => p.completed).length,
        inProgress: myPaths.filter((p) => !p.completed && p.completionPercent > 0).length,
        pending: myPaths.filter((p) => p.completionPercent === 0).length,
      });
    }
  );

  /**
   * GET /learning-paths/:id
   * Full detail of a learning path with its courses
   */
  app.get(
    "/learning-paths/:id",
    {
      id: "get-learning-path",
      summary: "Learning path detail",
      description:
        "An active learning path with its courses in order and your progress. Course content (modules, topics) is only included for courses you can see; the rest come with modules: null. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Learning path id") },
      output: {
        schema: z
          .object({ learningPath: Row, courses: z.array(Obj), progress: Obj.nullable() })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const pathId = c.req.param("id");

      const path = await first(
        dbInstance,
        learningPathTable,
        and(eq(learningPathTable.id, pathId), eq(learningPathTable.active, true))
      );
      if (!path) {
        return c.json({ error: "Learning Path not found" }, 404);
      }

      const userProgress =
        (await first(
          dbInstance,
          learningPathProgressTable,
          and(
            eq(learningPathProgressTable.userId, actor.id!),
            eq(learningPathProgressTable.learningPathId, pathId)
          )
        )) ?? null;

      const links = await dbInstance
        .select({
          position: learningPathCourseTable.position,
          required: learningPathCourseTable.required,
          estimatedDays: learningPathCourseTable.estimatedDays,
          courseId: learningPathCourseTable.courseId,
          title: courseTable.title,
          description: courseTable.description,
          durationHours: courseTable.durationHours,
          coverColor: courseTable.coverColor,
          active: courseTable.active,
        })
        .from(learningPathCourseTable)
        .innerJoin(courseTable, eq(courseTable.id, learningPathCourseTable.courseId))
        .where(eq(learningPathCourseTable.learningPathId, pathId))
        .orderBy(asc(learningPathCourseTable.position));

      // The catalog (titles) is visible; the CONTENT of each course only to
      // whoever can see it. Before, all the topics of all the courses went to
      // any account.
      const courses = await inSeries(links, async (e: { courseId: string; active: boolean }) => {
        const ve = await canViewCourse(actor, { id: e.courseId, active: e.active });
        if (!ve) return { ...e, modules: null };
        const modules = await courseTree(e.courseId, managesAcademy(actor));
        return { ...e, modules: modules.map(({ quiz: _q, ...m }) => m) };
      });

      return c.json({
        learningPath: path,
        courses,
        progress: userProgress,
      });
    }
  );

  /**
   * POST /learning-paths (Admin)
   * Create a new learning path
   */
  const createLearningPathSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    category: z.string().optional(),
    estimatedHours: z.number().positive().optional(),
    mediaId: z.string().optional(), // Reference to kon-media (learning path image)
    requiresSequentialApproval: z.boolean().default(false),
    courses: z
      .array(
        z.object({
          courseId: z.string(),
          position: z.number().int().positive(),
          required: z.boolean().default(true),
          estimatedDays: z.number().int().positive().optional(),
        })
      )
      .min(1, "It must include at least one course"),
  });

  app.post(
    "/learning-paths",
    {
      id: "create-learning-path",
      summary: "Create a learning path",
      description:
        "Creates a learning path with its ordered list of courses (at least one). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createLearningPathSchema, validatesHandler: true },
      output: {
        status: 201,
        schema: z
          .object({ success: z.literal(true), learningPath: Row, totalCourses: z.number() })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createLearningPathSchema, input.body);
      if (valid instanceof Response) return valid;
      const admin = requireUser(c);
      const data = valid;

      // Create the learning path
      const [path] = await dbInstance
        .insert(learningPathTable)
        .values({
          name: data.name,
          description: data.description,
          category: data.category,
          estimatedHours: data.estimatedHours?.toString(),
          mediaId: data.mediaId,
          requiresSequentialApproval: data.requiresSequentialApproval,
          createdById: admin.id,
        })
        .returning();

      // Add courses to the path
      const insertedCourses = await dbInstance
        .insert(learningPathCourseTable)
        .values(
          data.courses.map((c) => ({
            learningPathId: path.id,
            courseId: c.courseId,
            position: c.position,
            required: c.required,
            estimatedDays: c.estimatedDays,
          }))
        )
        .returning();

      return c.json(
        {
          success: true,
          learningPath: path,
          totalCourses: insertedCourses.length,
        },
        201
      );
    }
  );

  /**
   * PUT /learning-paths/:id (Admin)
   * Update a learning path
   */
  const updateLearningPathSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    category: z.string().optional(),
    estimatedHours: z.number().positive().optional(),
    mediaId: z.string().optional(), // Reference to kon-media (learning path image)
    active: z.boolean().optional(),
    requiresSequentialApproval: z.boolean().optional(),
  });

  app.put(
    "/learning-paths/:id",
    {
      id: "update-learning-path",
      summary: "Update a learning path",
      description:
        "Changes the given fields of a learning path (name, description, category, hours, image, active, sequential approval). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Learning path id"),
        body: updateLearningPathSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("learningPath") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateLearningPathSchema, input.body);
      if (valid instanceof Response) return valid;
      const pathId = c.req.param("id");
      const data = valid;

      const [path] = await dbInstance
        .update(learningPathTable)
        .set({
          name: data.name,
          description: data.description,
          category: data.category,
          estimatedHours: data.estimatedHours?.toString(),
          mediaId: data.mediaId,
          active: data.active,
          requiresSequentialApproval: data.requiresSequentialApproval,
          updatedAt: new Date(),
        })
        .where(eq(learningPathTable.id, pathId))
        .returning();

      if (!path) {
        return c.json({ error: "Learning Path not found" }, 404);
      }

      return c.json({ success: true, learningPath: path });
    }
  );

  /**
   * POST /learning-paths/:id/assign
   * Assign a whole learning path to user(s)
   */
  const assignLearningPathSchema = z.object({
    userIds: z.array(z.string()).optional(),
    groupIds: z.array(z.string()).optional(),
    dueDate: z.string().datetime().optional(),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
    notes: z.string().optional(),
  });

  app.post(
    "/learning-paths/:id/assign",
    {
      id: "assign-learning-path",
      summary: "Assign a learning path",
      description:
        "Assigns the learning path and every course in it to the given users and the members of the given groups. A supervisor may only assign to the users and groups they supervise (403). Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: {
        params: ParamId("Learning path id"),
        body: assignLearningPathSchema,
        validatesHandler: true,
      },
      output: {
        status: 201,
        schema: z
          .object({ success: z.literal(true), message: z.string(), results: Obj })
          .passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      sensitive: true,
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, assignLearningPathSchema, input.body);
      if (valid instanceof Response) return valid;
      const admin = requireUser(c);
      const pathId = c.req.param("id");
      const data = valid;

      if (
        (!data.userIds || data.userIds.length === 0) &&
        (!data.groupIds || data.groupIds.length === 0)
      ) {
        return c.json({ error: "You must specify at least one userId or groupId" }, 400);
      }
      const outOfGroup = await outsideTheirGroups(await actorOf(c), {
        userIds: data.userIds,
        groupIds: data.groupIds,
      });
      if (outOfGroup) return c.json({ error: outOfGroup }, 403);

      // Check that the learning path exists
      const path = await first(dbInstance, learningPathTable, eq(learningPathTable.id, pathId));

      if (!path) {
        return c.json({ error: "Learning Path not found" }, 404);
      }

      // Get the path's courses
      const coursesOfPath = await all(
        dbInstance,
        learningPathCourseTable,
        eq(learningPathCourseTable.learningPathId, pathId)
      );

      if (coursesOfPath.length === 0) {
        return c.json({ error: "The Learning Path has no assigned courses" }, 400);
      }

      // Get all target users
      const targetUsers = new Set<string>();

      if (data.userIds) {
        data.userIds.forEach((id) => targetUsers.add(id));
      }

      if (data.groupIds) {
        for (const groupId of data.groupIds) {
          const members = await dbInstance
            .select({ userId: groupUserTable.userId })
            .from(groupUserTable)
            .where(eq(groupUserTable.groupId, groupId));
          members.forEach((m: { userId: string }) => targetUsers.add(m.userId));
        }
      }

      const results = {
        assignedUsers: 0,
        assignedCourses: 0,
        startedPaths: 0,
      };

      // Assign the path and all its courses to each user
      for (const userId of Array.from(targetUsers)) {
        // Create/update learning path progress
        await dbInstance
          .insert(learningPathProgressTable)
          .values({
            userId,
            learningPathId: pathId,
            totalCourses: coursesOfPath.length,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
          })
          .onConflictDoNothing();

        // Record the path assignment
        await dbInstance
          .insert(learningPathAssignmentTable)
          .values({
            learningPathId: pathId,
            userId,
            assignedById: admin.id,
            dueDate: data.dueDate ? new Date(data.dueDate) : null,
            priority: data.priority,
            notes: data.notes,
          })
          .onConflictDoNothing();

        results.startedPaths++;

        // Assign each course of the path
        for (const coursePath of coursesOfPath) {
          // `assignments` has no unique index (user, course): the
          // `onConflictDoNothing` prevented nothing and an already assigned course showed up
          // twice in the reports (phase D, 2026-10-25).
          const alreadyAssigned = await first(
            dbInstance,
            assignmentTable,
            and(eq(assignmentTable.userId, userId), eq(assignmentTable.courseId, coursePath.courseId))
          );
          if (!alreadyAssigned) {
            await dbInstance.insert(assignmentTable).values({
              courseId: coursePath.courseId,
              userId,
              method: "manual",
              assignedById: admin.id,
              notes: `Assigned via Learning Path: ${path.name}`,
            });
          }

          await dbInstance
            .insert(courseProgressTable)
            .values({
              userId,
              courseId: coursePath.courseId,
            })
            .onConflictDoNothing();

          results.assignedCourses++;
        }

        results.assignedUsers++;
      }

      return c.json(
        {
          success: true,
          message: `Learning Path "${path.name}" assigned to ${results.assignedUsers} users`,
          results: {
            ...results,
            totalCoursesInPath: coursesOfPath.length,
          },
        },
        201
      );
    }
  );

  // ============================================
  // GROUPS
  // ============================================

  /**
   * GET /groups
   * List assignment groups
   */
  app.get(
    "/groups",
    {
      id: "list-groups",
      summary: "List groups",
      description:
        "Academy staff get every group with its members; anyone else gets only the groups they belong to, without the member list. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      output: { schema: listing("groups") },
    },
    async (c) => {
      const actor = await actorOf(c);

      if (!managesAcademy(actor)) {
        // A student —or any account without a profile, which used to fall into the
        // "admin/supervisor" branch and saw ALL the groups with their members— sees
        // only the groups they belong to, without the list of peers.
        const groups = await dbInstance
          .select({
            id: assignmentGroupTable.id,
            name: assignmentGroupTable.name,
            description: assignmentGroupTable.description,
            active: assignmentGroupTable.active,
          })
          .from(assignmentGroupTable)
          .innerJoin(groupUserTable, eq(groupUserTable.groupId, assignmentGroupTable.id))
          .where(eq(groupUserTable.userId, actor.id!));
        return c.json({ groups, total: groups.length });
      }

      const groups = await dbInstance.select().from(assignmentGroupTable);
      const ids = groups.map((g: { id: string }) => g.id);
      const members = ids.length
        ? await dbInstance
            .select()
            .from(groupUserTable)
            .where(inArray(groupUserTable.groupId, ids))
        : [];
      return c.json({
        groups: groups.map((g: { id: string }) => ({
          ...g,
          members: members.filter((m: { groupId: string }) => m.groupId === g.id),
        })),
        total: groups.length,
      });
    }
  );

  /**
   * POST /groups (Admin)
   * Create a new group
   */
  const createGroupSchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    supervisorPrincipalId: z.string().optional(),
  });

  app.post(
    "/groups",
    {
      id: "create-group",
      summary: "Create a group",
      description: "Creates an assignment group. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createGroupSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("group") },
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createGroupSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      const [group] = await dbInstance.insert(assignmentGroupTable).values(data).returning();

      return c.json({ success: true, group }, 201);
    }
  );

  /**
   * POST /groups/:id/members
   * Add members to a group
   */
  const addMembersSchema = z.object({
    userIds: z.array(z.string()),
  });

  app.post(
    "/groups/:id/members",
    {
      id: "add-group-members",
      summary: "Add members to a group",
      description:
        "Adds the given user ids to the group (already-members are skipped). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Group id"),
        body: addMembersSchema,
        validatesHandler: true,
      },
      output: {
        schema: z.object({ success: z.literal(true), added: z.number() }).passthrough(),
      },
      errors: ["KITSUDEN_E_CONFLICT"],
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, addMembersSchema, input.body);
      if (valid instanceof Response) return valid;
      const groupId = c.req.param("id");
      const { userIds } = valid;
      // With an empty list, drizzle threw "values() must be called with at
      // least one value" → 500. There is nobody to add.
      if (userIds.length === 0) return c.json({ success: true, added: 0 });

      const values = userIds.map((userId) => ({
        groupId,
        userId,
      }));

      await dbInstance.insert(groupUserTable).values(values).onConflictDoNothing();

      return c.json({ success: true, added: userIds.length });
    }
  );

  // ============================================
  // SURVEYS
  // ============================================

  /**
   * POST /surveys
   * Submit a satisfaction survey
   */
  const surveySchema = z.object({
    courseId: z.string(),
    department: z.enum(departmentEnum.enumValues),
    jobTitle: z.enum(jobTitleEnum.enumValues),
    presenter: z.number().int().min(1).max(5),
    usefulness: z.boolean(),
    satisfaction: z.number().int().min(1).max(5),
    learned: z.string().max(300),
    place: z.enum(placeEnum.enumValues),
    role: z.enum(surveyRoleEnum.enumValues),
    recommendation: z.string().max(200).optional(),
    courseComments: z.string().max(500),
  });

  app.post(
    "/surveys",
    {
      id: "submit-survey",
      summary: "Send the satisfaction survey",
      description:
        "Sends the satisfaction survey of a course you completed (400 otherwise) and marks it done in your progress; it is required for the certificate. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: surveySchema, validatesHandler: true },
      output: { status: 201, schema: withRow("survey") },
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, surveySchema, input.body);
      if (valid instanceof Response) return valid;
      const user = requireUser(c);
      const data = valid;

      // Check that the course is completed
      const progress = await first(
        dbInstance,
        courseProgressTable,
        and(eq(courseProgressTable.userId, user.id), eq(courseProgressTable.courseId, data.courseId))
      );

      if (!progress?.completed) {
        return c.json({ error: "You must complete the course before submitting the survey" }, 400);
      }

      // Create survey
      const [survey] = await dbInstance
        .insert(satisfactionSurveyTable)
        .values({
          ...data,
          userId: user.id,
          // The column is boolean. The code inserted "si"/"no" (strings):
          // Postgres tolerates 'no' as false but 'si' is NOT a boolean literal —
          // every survey with utilidad=true returned 500. The typing exposed it.
          usefulness: data.usefulness,
        })
        .returning();

      // Mark survey as completed in the progress
      await dbInstance
        .update(courseProgressTable)
        .set({ surveyCompleted: true })
        .where(
          and(eq(courseProgressTable.userId, user.id), eq(courseProgressTable.courseId, data.courseId))
        );

      return c.json({ success: true, survey }, 201);
    }
  );

  /**
   * GET /surveys (Admin)
   * Get all surveys
   */
  app.get(
    "/surveys",
    {
      id: "list-surveys",
      summary: "List surveys",
      description:
        "Satisfaction surveys, newest first, optionally of one course. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { query: query({ courseId: text("Course id") }) },
      output: { schema: listing("surveys") },
    },
    async (c) => {
      const courseId = c.req.query("courseId");

      const surveys = await dbInstance
        .select()
        .from(satisfactionSurveyTable)
        .where(courseId ? eq(satisfactionSurveyTable.courseId, courseId) : undefined)
        .orderBy(desc(satisfactionSurveyTable.date));

      return c.json({ surveys, total: surveys.length });
    }
  );

  // ============================================
  // DASHBOARD AND REPORTS
  // ============================================

  /**
   * GET /dashboard
   * Dashboard with system metrics
   */
  app.get(
    "/dashboard",
    {
      id: "get-dashboard",
      summary: "Academy dashboard",
      description:
        "Totals (courses, modules, topics, quizzes, groups, assignments, completions, feedback, surveys), hours, completion rate and alerts. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      output: { schema: z.object({ metrics: Obj, alerts: z.array(Obj) }).passthrough() },
    },
    async (c) => {
      // Basic counts
      const [totalCourses] = await dbInstance.select({ count: count() }).from(courseTable);
      const [totalModules] = await dbInstance.select({ count: count() }).from(moduleTable);
      const [totalTopics] = await dbInstance.select({ count: count() }).from(topicTable);
      const [totalQuizzes] = await dbInstance.select({ count: count() }).from(quizTable);
      const [totalQuestions] = await dbInstance.select({ count: count() }).from(questionTable);
      const [totalGroups] = await dbInstance.select({ count: count() }).from(assignmentGroupTable);
      const [totalAssignments] = await dbInstance.select({ count: count() }).from(assignmentTable);
      const [totalCompletedCourses] = await dbInstance
        .select({ count: count() })
        .from(courseProgressTable)
        .where(eq(courseProgressTable.completed, true));
      const [totalFeedbacks] = await dbInstance.select({ count: count() }).from(feedbackTable);
      const [totalSurveys] = await dbInstance
        .select({ count: count() })
        .from(satisfactionSurveyTable);

      // Duration metrics
      const durationStats = await dbInstance
        .select({
          totalHours: sum(courseTable.durationHours),
          averageHours: avg(courseTable.durationHours),
          count: count(),
        })
        .from(courseTable);

      // Completion rate
      const completionRate =
        totalAssignments.count > 0
          ? Math.round((totalCompletedCourses.count / totalAssignments.count) * 100)
          : 0;

      // Promedios
      const averageModules =
        totalCourses.count > 0 ? Math.round((totalModules.count / totalCourses.count) * 10) / 10 : 0;

      const averageTopics =
        totalModules.count > 0 ? Math.round((totalTopics.count / totalModules.count) * 10) / 10 : 0;

      // Alerts
      const alerts = [];
      if (totalCourses.count === 0) {
        alerts.push({
          type: "warning",
          message: "No courses available - Create educational content",
        });
      }
      if (totalAssignments.count === 0) {
        alerts.push({ type: "warning", message: "No users assigned - Create assignments" });
      }
      if (totalCourses.count > 0 && totalModules.count > 0 && totalAssignments.count > 0) {
        alerts.push({ type: "success", message: "System working correctly" });
      }

      return c.json({
        metrics: {
          totalCourses: totalCourses.count,
          totalModules: totalModules.count,
          totalTopics: totalTopics.count,
          totalQuizzes: totalQuizzes.count,
          totalQuestions: totalQuestions.count,
          totalGroups: totalGroups.count,
          totalAssignments: totalAssignments.count,
          totalCompletedCourses: totalCompletedCourses.count,
          totalFeedbacks: totalFeedbacks.count,
          totalSurveys: totalSurveys.count,
          totalAvailableHours: Number(durationStats[0].totalHours ?? 0),
          averageCourseDuration: Number(durationStats[0].averageHours ?? 0),
          completionRate,
          averageModules,
          averageTopics,
        },
        alerts,
      });
    }
  );

  /**
   * GET /dashboard/my-progress
   * Progress of the authenticated user
   */
  app.get(
    "/dashboard/my-progress",
    {
      id: "get-my-progress",
      summary: "My progress",
      description:
        "Your assigned courses with their modules and topics, your progress in each and how many you completed. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      output: {
        schema: z
          .object({
            courses: z.array(Obj),
            totalAssigned: z.number(),
            totalCompleted: z.number(),
          })
          .passthrough(),
      },
    },
    async (c) => {
      const user = requireUser(c);

      // Assigned courses
      // (Before a nested `with` course → modules → topics: see academy.queries.ts.)
      const assignmentsWithCourse = (
        await withRelation(
          dbInstance,
          await all(dbInstance, assignmentTable, eq(assignmentTable.userId, user.id)),
          "courseId",
          courseTable,
          "course"
        )
      ).filter((a) => a.course !== null);
      const courseIds = [...new Set(assignmentsWithCourse.map((a) => a.courseId))];
      const modulesOfCourses = courseIds.length
        ? await all(dbInstance, moduleTable, inArray(moduleTable.courseId, courseIds), [
            asc(moduleTable.position),
          ])
        : [];
      const topicsOfModules = modulesOfCourses.length
        ? await all(
            dbInstance,
            topicTable,
            inArray(
              topicTable.moduleId,
              modulesOfCourses.map((m) => m.id)
            ),
            [asc(topicTable.position)]
          )
        : [];
      const assignments = assignmentsWithCourse.map((a) => ({
        ...a,
        course: {
          ...(a.course as Course),
          modules: modulesOfCourses
            .filter((m) => m.courseId === a.courseId)
            .map((m) => ({ ...m, topics: topicsOfModules.filter((t) => t.moduleId === m.id) })),
        },
      }));

      // Progress of each course
      const coursesWithProgress = await inSeries(assignments, async (assignment) => {
        const course: Course & { modules: (Module & { topics: Topic[] })[] } = assignment.course;
        const progress = await first(
          dbInstance,
          courseProgressTable,
          and(eq(courseProgressTable.userId, user.id), eq(courseProgressTable.courseId, course.id))
        );

        const totalTopics = course.modules.reduce((sum, m) => sum + m.topics.length, 0);

        return {
          course,
          progress,
          totalTopics,
        };
      });

      return c.json({
        courses: coursesWithProgress,
        totalAssigned: coursesWithProgress.length,
        totalCompleted: coursesWithProgress.filter((c) => c.progress?.completed).length,
      });
    }
  );

  // ============================================
  // CERTIFICATES
  // ============================================

  /**
   * GET /certificates/:courseId
   * Generate/get the certificate of a course
   */
  app.get(
    "/certificates/:courseId",
    {
      id: "get-certificate",
      summary: "Get my certificate of a course",
      description:
        "Issues (or returns) your certificate of a course once you completed it and its survey (403 otherwise), and returns its verification code. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: CourseParam },
      output: {
        schema: z.object({ success: z.literal(true), certificate: Obj }).passthrough(),
      },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const user = requireUser(c);
      const courseId = c.req.param("courseId");

      // A course that does not exist is a 404, not a "not eligible" (403): 403 is
      // for authorization, and the matrix reads it that way (phase D).
      if (!(await first(dbInstance, courseTable, eq(courseTable.id, courseId)))) {
        return c.json({ error: "Course not found" }, 404);
      }

      // Check that the course is completed and the survey done
      const progress = await first(
        dbInstance,
        courseProgressTable,
        and(
          eq(courseProgressTable.userId, user.id),
          eq(courseProgressTable.courseId, courseId),
          eq(courseProgressTable.completed, true),
          eq(courseProgressTable.surveyCompleted, true)
        )
      );

      if (!progress) {
        return c.json(
          {
            error:
              "Not eligible for a certificate. You must complete the course and the satisfaction survey.",
          },
          403
        );
      }

      const course = await first(dbInstance, courseTable, eq(courseTable.id, courseId));

      // Unpredictable code (before: id prefixes + clock, and in lowercase,
      // so it did not even pass `validateCertificateCode`).
      const code = certificateCode();

      // Create or update certificate
      const [certificate] = await dbInstance
        .insert(certificateTable)
        .values({
          userId: user.id,
          courseId,
          code,
          dataJson: {
            userName: user.name,
            courseName: course?.title,
            completedAt: progress.completedAt,
            durationHours: course?.durationHours,
          },
        })
        .onConflictDoUpdate({
          target: [certificateTable.userId, certificateTable.courseId],
          set: {
            downloadedAt: new Date(),
          },
        })
        .returning();

      // Update progress
      await dbInstance
        .update(courseProgressTable)
        .set({
          certificateDownloaded: true,
          certificateDownloadedAt: new Date(),
        })
        .where(
          and(eq(courseProgressTable.userId, user.id), eq(courseProgressTable.courseId, courseId))
        );

      return c.json({
        success: true,
        certificate: {
          code: certificate.code,
          course: course?.title,
          date: progress.completedAt,
        },
      });
    }
  );

  // ============================================
  // FEEDBACK
  // ============================================

  /**
   * POST /feedback
   * Submit feedback about a topic
   */
  const feedbackSchema = z
    .object({
      topicId: z.string().max(64),
      rating: z.number().int().min(1).max(5),
      comment: z.string().max(2000).optional(),
    })
    .strict();

  app.post(
    "/feedback",
    {
      id: "submit-feedback",
      summary: "Rate a topic",
      description:
        "Saves (or replaces) your 1-5 rating and comment of a topic of a course assigned to you (404 otherwise). Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: feedbackSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("feedback") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, feedbackSchema, input.body);
      if (valid instanceof Response) return valid;
      const actor = await actorOf(c);
      const user = { id: actor.id! };
      const data = valid;

      // Only for topics of courses the user can see.
      const [topic] = await dbInstance
        .select({ moduleId: topicTable.moduleId })
        .from(topicTable)
        .where(eq(topicTable.id, data.topicId))
        .limit(1);
      const course = topic ? await courseOfModule(topic.moduleId) : null;
      if (!course || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Topic not found" }, 404);
      }

      const [feedback] = await dbInstance
        .insert(feedbackTable)
        .values({
          userId: user.id,
          topicId: data.topicId,
          rating: data.rating,
          comment: data.comment,
        })
        .onConflictDoUpdate({
          target: [feedbackTable.userId, feedbackTable.topicId],
          set: {
            rating: data.rating,
            comment: data.comment,
          },
        })
        .returning();

      return c.json({ success: true, feedback }, 201);
    }
  );

  // ============================================
  // COURSES - FULL CRUD (MISSING)
  // ============================================

  /**
   * PUT /courses/:id
   * Update an existing course
   */
  const updateCourseSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    startDate: z.string().datetime().optional().nullable(),
    endDate: z.string().datetime().optional().nullable(),
    durationHours: z.number().positive().optional(),
    mediaId: z.string().optional().nullable(), // Reference to kon-media
    coverColor: z.string().optional(),
    courseType: z.enum(courseTypeEnum.enumValues).optional(),
    active: z.boolean().optional(),
  });

  app.put(
    "/courses/:id",
    {
      id: "update-course",
      summary: "Update a course",
      description:
        "Changes the given fields of a course (title, description, dates, hours, cover, type, active). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Course id"),
        body: updateCourseSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("course") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateCourseSchema, input.body);
      if (valid instanceof Response) return valid;
      const courseId = c.req.param("id");
      const data = valid;

      const [course] = await dbInstance
        .update(courseTable)
        .set({
          ...data,
          startDate: data.startDate
            ? new Date(data.startDate)
            : data.startDate === null
              ? null
              : undefined,
          endDate: data.endDate
            ? new Date(data.endDate)
            : data.endDate === null
              ? null
              : undefined,
          durationHours: data.durationHours?.toString(),
          updatedAt: new Date(),
        })
        .where(eq(courseTable.id, courseId))
        .returning();

      if (!course) {
        return c.json({ error: "Course not found" }, 404);
      }

      return c.json({ success: true, course });
    }
  );

  /**
   * DELETE /courses/:id
   * Delete a course (soft delete, marking it inactive)
   */
  app.delete(
    "/courses/:id",
    {
      id: "deactivate-course",
      summary: "Deactivate a course",
      description:
        "Soft-deletes a course: marks it inactive, so students stop seeing it. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Course id") },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const courseId = c.req.param("id");

      const [course] = await dbInstance
        .update(courseTable)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(courseTable.id, courseId))
        .returning();

      if (!course) {
        return c.json({ error: "Course not found" }, 404);
      }

      return c.json({ success: true, message: "Course deactivated" });
    }
  );

  /**
   * GET /courses/:id/stats
   * Detailed statistics of a course
   */
  app.get(
    "/courses/:id/stats",
    {
      id: "get-course-stats",
      summary: "Course statistics",
      description:
        "Assigned, completed, in progress and not started students, completion rate, average progress, quiz results and survey averages of a course. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { params: ParamId("Course id") },
      output: { schema: z.object({ stats: Obj }).passthrough() },
    },
    async (c) => {
      const courseId = c.req.param("id");

      // Total assigned users
      const [{ count: totalAssigned }] = await dbInstance
        .select({ count: count() })
        .from(assignmentTable)
        .where(eq(assignmentTable.courseId, courseId));

      // Completed
      const [{ count: completedItems }] = await dbInstance
        .select({ count: count() })
        .from(courseProgressTable)
        .where(
          and(eq(courseProgressTable.courseId, courseId), eq(courseProgressTable.completed, true))
        );

      // In progress
      const [{ count: inProgress }] = await dbInstance
        .select({ count: count() })
        .from(courseProgressTable)
        .where(
          and(
            eq(courseProgressTable.courseId, courseId),
            eq(courseProgressTable.completed, false),
            gt(courseProgressTable.progressPercent, 0)
          )
        );

      // Average progress
      const [progressAvg] = await dbInstance
        .select({ avg: avg(courseProgressTable.progressPercent) })
        .from(courseProgressTable)
        .where(eq(courseProgressTable.courseId, courseId));

      // Quiz results
      const quizResults = await dbInstance
        .select({
          passed: count(),
          averageScore: avg(quizResultTable.scorePercent),
        })
        .from(quizResultTable)
        .innerJoin(quizTable, eq(quizResultTable.quizId, quizTable.id))
        .innerJoin(moduleTable, eq(quizTable.moduleId, moduleTable.id))
        .where(and(eq(moduleTable.courseId, courseId), eq(quizResultTable.passed, true)));

      // Satisfaction surveys
      const surveysStats = await dbInstance
        .select({
          total: count(),
          averageSatisfaction: avg(satisfactionSurveyTable.satisfaction),
          averagePresenter: avg(satisfactionSurveyTable.presenter),
        })
        .from(satisfactionSurveyTable)
        .where(eq(satisfactionSurveyTable.courseId, courseId));

      return c.json({
        stats: {
          totalAssigned,
          completedItems,
          inProgress,
          notStarted: totalAssigned - completedItems - inProgress,
          finishRate:
            totalAssigned > 0 ? Math.round((completedItems / totalAssigned) * 100) : 0,
          averageProgress: Math.round(Number(progressAvg.avg ?? 0)),
          passedQuiz: Number(quizResults[0]?.passed ?? 0),
          averageQuizScore: Math.round(Number(quizResults[0]?.averageScore ?? 0)),
          totalSurveys: Number(surveysStats[0]?.total ?? 0),
          averageSatisfaction:
            Math.round(Number(surveysStats[0]?.averageSatisfaction ?? 0) * 10) / 10,
          averagePresenter:
            Math.round(Number(surveysStats[0]?.averagePresenter ?? 0) * 10) / 10,
        },
      });
    }
  );

  /**
   * GET /courses/:id/modules
   * List all the modules of a course
   */
  app.get(
    "/courses/:id/modules",
    {
      id: "list-course-modules",
      summary: "List the modules of a course",
      description:
        "The modules of a course with their topics and quiz (without questions). A course you are not assigned to is a 404. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Course id") },
      output: { schema: listing("modules") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const courseId = c.req.param("id");

      const [course] = await dbInstance
        .select()
        .from(courseTable)
        .where(eq(courseTable.id, courseId))
        .limit(1);
      if (!course || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Course not found" }, 404);
      }

      // Modules with topics and the quiz WITHOUT questions (as before: `quiz: true`).
      const modules = (await courseTree(courseId, managesAcademy(actor))).map((m) => ({
        ...m,
        topics: m.topics.map(({ files: _a, ...t }) => t),
        quiz: m.quiz ? (({ questions: _p, ...q }) => q)(m.quiz) : null,
      }));
      return c.json({ modules, total: modules.length });
    }
  );

  // ============================================
  // MODULES - FULL CRUD
  // ============================================

  /**
   * GET /modules/:id
   * Get the detail of a module with its topics
   */
  app.get(
    "/modules/:id",
    {
      id: "get-module",
      summary: "Module detail",
      description:
        "A module with its topics, files, quiz (with questions; students never see which option is correct) and its course. A module of a course you are not assigned to is a 404. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Module id") },
      output: { schema: z.object({ module: Row }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const moduleId = c.req.param("id");

      // Before: no check at all, and with the quiz's `isCorrect` options.
      const course = await courseOfModule(moduleId);
      if (!course || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Module not found" }, 404);
      }
      const [mod] = await courseTree(course.id, managesAcademy(actor), moduleId);
      if (!mod) {
        return c.json({ error: "Module not found" }, 404);
      }
      const [courseRow] = await dbInstance
        .select()
        .from(courseTable)
        .where(eq(courseTable.id, course.id))
        .limit(1);

      return c.json({ module: { ...mod, course: courseRow } });
    }
  );

  /**
   * POST /modules
   * Create a new module
   */
  const createModuleSchema = z.object({
    courseId: z.string(),
    title: z.string().min(1),
    description: z.string().optional(),
    position: z.number().int().positive().default(1),
  });

  app.post(
    "/modules",
    {
      id: "create-module",
      summary: "Create a module",
      description: "Creates a module in a course. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createModuleSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("module") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createModuleSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      // If no order is specified, put it at the end
      if (!data.position) {
        const [{ max }] = await dbInstance
          .select({ max: sql<number>`MAX(${moduleTable.position})` })
          .from(moduleTable)
          .where(eq(moduleTable.courseId, data.courseId));
        data.position = (max || 0) + 1;
      }

      const [mod] = await dbInstance.insert(moduleTable).values(data).returning();

      return c.json({ success: true, module: mod }, 201);
    }
  );

  /**
   * PUT /modules/:id
   * Update a module
   */
  const updateModuleSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    position: z.number().int().positive().optional(),
    active: z.boolean().optional(),
  });

  app.put(
    "/modules/:id",
    {
      id: "update-module",
      summary: "Update a module",
      description:
        "Changes the given fields of a module (title, description, order, active). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Module id"),
        body: updateModuleSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("module") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateModuleSchema, input.body);
      if (valid instanceof Response) return valid;
      const moduleId = c.req.param("id");
      const data = valid;

      const [mod] = await dbInstance
        .update(moduleTable)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(moduleTable.id, moduleId))
        .returning();

      if (!mod) {
        return c.json({ error: "Module not found" }, 404);
      }

      return c.json({ success: true, module: mod });
    }
  );

  /**
   * DELETE /modules/:id
   * Delete a module
   */
  app.delete(
    "/modules/:id",
    {
      id: "delete-module",
      summary: "Delete a module",
      description:
        "Deletes a module with its topics, quiz and the progress on them. Cannot be undone. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Module id") },
      output: { schema: Done },
    },
    async (c) => {
      const moduleId = c.req.param("id");

      await dbInstance.delete(moduleTable).where(eq(moduleTable.id, moduleId));

      return c.json({ success: true, message: "Module deleted" });
    }
  );

  /**
   * POST /modules/reorder
   * Reorder the modules of a course
   */
  const reorderModulesSchema = z.object({
    courseId: z.string(),
    position: z.array(
      z.object({
        moduleId: z.string(),
        position: z.number().int().positive(),
      })
    ),
  });

  app.post(
    "/modules/reorder",
    {
      id: "reorder-modules",
      summary: "Reorder modules",
      description:
        "Sets the order of the given modules. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: reorderModulesSchema, validatesHandler: true },
      output: { schema: Done },
      sensitive: true,
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, reorderModulesSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      for (const item of data.position) {
        await dbInstance
          .update(moduleTable)
          .set({ position: item.position })
          .where(eq(moduleTable.id, item.moduleId));
      }

      return c.json({ success: true, message: "Modules reordered" });
    }
  );

  // ============================================
  // TOPICS - FULL CRUD
  // ============================================

  /**
   * POST /topics
   * Create a new topic
   */
  const createTopicSchema = z.object({
    moduleId: z.string(),
    title: z.string().min(1),
    content: z.string().min(1),
    position: z.number().int().positive().default(1),
    videoLocal: z.string().optional(), // Reference to kon-media
    videoYoutube: z.string().optional(),
    externalVideo: z.string().optional(),
    imageId: z.string().optional(), // Reference to kon-media
    documentId: z.string().optional(), // Reference to kon-media
  });

  app.post(
    "/topics",
    {
      id: "create-topic",
      summary: "Create a topic",
      description:
        "Creates a topic in a module (content, video, image and document references). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createTopicSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("topic") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createTopicSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      // If no order is specified, put it at the end
      if (!data.position) {
        const [{ max }] = await dbInstance
          .select({ max: sql<number>`MAX(${topicTable.position})` })
          .from(topicTable)
          .where(eq(topicTable.moduleId, data.moduleId));
        data.position = (max || 0) + 1;
      }

      const [topic] = await dbInstance.insert(topicTable).values(data).returning();

      return c.json({ success: true, topic }, 201);
    }
  );

  /**
   * PUT /topics/:id
   * Update a topic
   */
  const updateTopicSchema = z.object({
    title: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
    position: z.number().int().positive().optional(),
    videoLocal: z.string().optional().nullable(), // Reference to kon-media
    videoYoutube: z.string().optional().nullable(),
    externalVideo: z.string().optional().nullable(),
    imageId: z.string().optional().nullable(), // Reference to kon-media
    documentId: z.string().optional().nullable(), // Reference to kon-media
    active: z.boolean().optional(),
  });

  app.put(
    "/topics/:id",
    {
      id: "update-topic",
      summary: "Update a topic",
      description:
        "Changes the given fields of a topic. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Topic id"), body: updateTopicSchema, validatesHandler: true },
      output: { schema: withRow("topic") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateTopicSchema, input.body);
      if (valid instanceof Response) return valid;
      const topicId = c.req.param("id");
      const data = valid;

      const [topic] = await dbInstance
        .update(topicTable)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(topicTable.id, topicId))
        .returning();

      if (!topic) {
        return c.json({ error: "Topic not found" }, 404);
      }

      return c.json({ success: true, topic });
    }
  );

  /**
   * DELETE /topics/:id
   * Delete a topic
   */
  app.delete(
    "/topics/:id",
    {
      id: "delete-topic",
      summary: "Delete a topic",
      description:
        "Deletes a topic with its files, feedback and progress. Cannot be undone. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Topic id") },
      output: { schema: Done },
    },
    async (c) => {
      const topicId = c.req.param("id");

      await dbInstance.delete(topicTable).where(eq(topicTable.id, topicId));

      return c.json({ success: true, message: "Topic deleted" });
    }
  );

  /**
   * POST /topics/reorder
   * Reorder the topics of a module
   */
  const reorderTopicsSchema = z.object({
    moduleId: z.string(),
    position: z.array(
      z.object({
        topicId: z.string(),
        position: z.number().int().positive(),
      })
    ),
  });

  app.post(
    "/topics/reorder",
    {
      id: "reorder-topics",
      summary: "Reorder topics",
      description:
        "Sets the order of the given topics. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: reorderTopicsSchema, validatesHandler: true },
      output: { schema: Done },
      sensitive: true,
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, reorderTopicsSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      for (const item of data.position) {
        await dbInstance
          .update(topicTable)
          .set({ position: item.position })
          .where(eq(topicTable.id, item.topicId));
      }

      return c.json({ success: true, message: "Topics reordered" });
    }
  );

  // ============================================
  // ADDITIONAL FILES
  // ============================================

  /**
   * POST /topics/:id/files
   * Add an additional file to a topic
   */
  const addFileSchema = z.object({
    name: z.string().min(1),
    file: z.string().min(1),
    position: z.number().int().positive().default(1),
  });

  app.post(
    "/topics/:id/files",
    {
      id: "add-topic-file",
      summary: "Add a file to a topic",
      description:
        "Adds an extra file (name and reference) to a topic. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Topic id"), body: addFileSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("file") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, addFileSchema, input.body);
      if (valid instanceof Response) return valid;
      const topicId = c.req.param("id");
      const data = valid;

      const [file] = await dbInstance
        .insert(additionalFileTable)
        .values({
          topicId,
          ...data,
        })
        .returning();

      return c.json({ success: true, file }, 201);
    }
  );

  /**
   * DELETE /files/:id
   * Delete an additional file
   */
  app.delete(
    "/files/:id",
    {
      id: "delete-file",
      summary: "Delete a topic file",
      description:
        "Removes an extra file from its topic. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("File id") },
      output: { schema: Done },
    },
    async (c) => {
      const fileId = c.req.param("id");

      await dbInstance.delete(additionalFileTable).where(eq(additionalFileTable.id, fileId));

      return c.json({ success: true, message: "File deleted" });
    }
  );

  // ============================================
  // QUIZZES - FULL CRUD
  // ============================================

  /**
   * GET /quizzes/:id
   * Get the detail of a quiz with questions
   */
  app.get(
    "/quizzes/:id",
    {
      id: "get-quiz",
      summary: "Quiz detail",
      description:
        "A quiz with its questions and options (students never see which option is correct) and its module. A quiz of a course you are not assigned to is a 404. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Quiz id") },
      output: { schema: z.object({ quiz: Row }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const quizId = c.req.param("id");

      const [row] = await dbInstance
        .select()
        .from(quizTable)
        .where(eq(quizTable.id, quizId))
        .limit(1);
      const course = row ? await courseOfModule(row.moduleId) : null;
      if (!row || !course || !(await canViewCourse(actor, course))) {
        return c.json({ error: "Quiz not found" }, 404);
      }
      const forTeam = managesAcademy(actor);
      const [mod] = await courseTree(course.id, forTeam, row.moduleId);
      if (!mod?.quiz) {
        return c.json({ error: "Quiz not found" }, 404);
      }
      const { quiz, topics: _t, ...moduleWithoutChildren } = mod;
      return c.json({ quiz: { ...quiz, module: { ...moduleWithoutChildren, course: { id: course.id } } } });
    }
  );

  /**
   * POST /quizzes
   * Create a new quiz
   */
  const createQuizSchema = z.object({
    moduleId: z.string(),
    title: z.string().min(1),
    instructions: z.string().optional(),
    mediaId: z.string().optional(), // Reference to kon-media (quiz cover)
    minPassingScore: z.number().int().min(0).max(100).default(70),
    timeLimitMinutes: z.number().int().positive().optional(),
  });

  app.post(
    "/quizzes",
    {
      id: "create-quiz",
      summary: "Create a quiz",
      description:
        "Creates the quiz of a module (one per module: 400 if it already has one). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createQuizSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("quiz") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createQuizSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      // Check that the module does not already have a quiz
      const existingQuiz = await first(
        dbInstance,
        quizTable,
        eq(quizTable.moduleId, data.moduleId)
      );

      if (existingQuiz) {
        return c.json({ error: "The module already has an assigned quiz" }, 400);
      }

      const [quiz] = await dbInstance.insert(quizTable).values(data).returning();

      return c.json({ success: true, quiz }, 201);
    }
  );

  /**
   * PUT /quizzes/:id
   * Update a quiz
   */
  const updateQuizSchema = z.object({
    title: z.string().min(1).optional(),
    instructions: z.string().optional(),
    mediaId: z.string().optional().nullable(), // Reference to kon-media (quiz cover)
    minPassingScore: z.number().int().min(0).max(100).optional(),
    timeLimitMinutes: z.number().int().positive().optional().nullable(),
    active: z.boolean().optional(),
  });

  app.put(
    "/quizzes/:id",
    {
      id: "update-quiz",
      summary: "Update a quiz",
      description:
        "Changes the given fields of a quiz (title, instructions, cover, pass mark, time limit, active). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Quiz id"), body: updateQuizSchema, validatesHandler: true },
      output: { schema: withRow("quiz") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateQuizSchema, input.body);
      if (valid instanceof Response) return valid;
      const quizId = c.req.param("id");
      const data = valid;

      const [quiz] = await dbInstance
        .update(quizTable)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(quizTable.id, quizId))
        .returning();

      if (!quiz) {
        return c.json({ error: "Quiz not found" }, 404);
      }

      return c.json({ success: true, quiz });
    }
  );

  /**
   * DELETE /quizzes/:id
   * Delete a quiz
   */
  app.delete(
    "/quizzes/:id",
    {
      id: "delete-quiz",
      summary: "Delete a quiz",
      description:
        "Deletes a quiz with its questions and results. Cannot be undone. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Quiz id") },
      output: { schema: Done },
    },
    async (c) => {
      const quizId = c.req.param("id");

      await dbInstance.delete(quizTable).where(eq(quizTable.id, quizId));

      return c.json({ success: true, message: "Quiz deleted" });
    }
  );

  // ============================================
  // QUESTIONS - FULL CRUD
  // ============================================

  /**
   * POST /quizzes/:id/questions
   * Add a question to a quiz
   */
  const createQuestionSchema = z.object({
    text: z.string().min(1),
    score: z.number().int().positive().default(10),
    position: z.number().int().positive().optional(),
    fileId: z.string().optional(), // Reference to kon-media (image/audio)
  });

  app.post(
    "/quizzes/:id/questions",
    {
      id: "create-question",
      summary: "Add a question to a quiz",
      description:
        "Adds a question to a quiz (at the end unless position is given). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Quiz id"), body: createQuestionSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("question") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createQuestionSchema, input.body);
      if (valid instanceof Response) return valid;
      const quizId = c.req.param("id");
      const data = valid;

      // If no order is specified, put it at the end
      if (!data.position) {
        const [{ max }] = await dbInstance
          .select({ max: sql<number>`MAX(${questionTable.position})` })
          .from(questionTable)
          .where(eq(questionTable.quizId, quizId));
        data.position = (max || 0) + 1;
      }

      const [question] = await dbInstance
        .insert(questionTable)
        .values({
          quizId,
          ...data,
        })
        .returning();

      return c.json({ success: true, question }, 201);
    }
  );

  /**
   * PUT /questions/:id
   * Update a question
   */
  const updateQuestionSchema = z.object({
    text: z.string().min(1).optional(),
    score: z.number().int().positive().optional(),
    position: z.number().int().positive().optional(),
    fileId: z.string().optional().nullable(), // Reference to kon-media (image/audio)
    active: z.boolean().optional(),
  });

  app.put(
    "/questions/:id",
    {
      id: "update-question",
      summary: "Update a question",
      description:
        "Changes the given fields of a question (400 when there is nothing to change). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Question id"),
        body: updateQuestionSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("question") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateQuestionSchema, input.body);
      if (valid instanceof Response) return valid;
      const questionId = c.req.param("id");
      const data = valid;
      // A body with no fields reached .set({}) and drizzle threw "No values to
      // set" → 500 (phase D, authorization matrix).
      if (Object.keys(data).length === 0) return c.json({ error: "Nothing to update" }, 400);

      const [question] = await dbInstance
        .update(questionTable)
        // The table has no updatedAt; the code set it and drizzle
        // silently ignored it.
        .set(data)
        .where(eq(questionTable.id, questionId))
        .returning();

      if (!question) {
        return c.json({ error: "Question not found" }, 404);
      }

      return c.json({ success: true, question });
    }
  );

  /**
   * DELETE /questions/:id
   * Delete a question
   */
  app.delete(
    "/questions/:id",
    {
      id: "delete-question",
      summary: "Delete a question",
      description:
        "Deletes a question with its options and answers. Cannot be undone. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Question id") },
      output: { schema: Done },
    },
    async (c) => {
      const questionId = c.req.param("id");

      await dbInstance.delete(questionTable).where(eq(questionTable.id, questionId));

      return c.json({ success: true, message: "Question deleted" });
    }
  );

  // ============================================
  // OPTIONS - FULL CRUD
  // ============================================

  /**
   * POST /questions/:id/options
   * Add an option to a question
   */
  const createOptionSchema = z.object({
    text: z.string().min(1),
    isCorrect: z.boolean().default(false),
    position: z.number().int().positive().optional(),
  });

  app.post(
    "/questions/:id/options",
    {
      id: "create-option",
      summary: "Add an option to a question",
      description:
        "Adds an answer option to a question (at the end unless position is given). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Question id"), body: createOptionSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("option") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createOptionSchema, input.body);
      if (valid instanceof Response) return valid;
      const questionId = c.req.param("id");
      const data = valid;

      // If no order is specified, put it at the end
      if (!data.position) {
        const [{ max }] = await dbInstance
          .select({ max: sql<number>`MAX(${optionTable.position})` })
          .from(optionTable)
          .where(eq(optionTable.questionId, questionId));
        data.position = (max || 0) + 1;
      }

      const [option] = await dbInstance
        .insert(optionTable)
        .values({
          questionId,
          ...data,
        })
        .returning();

      return c.json({ success: true, option }, 201);
    }
  );

  /**
   * PUT /options/:id
   * Update an option
   */
  const updateOptionSchema = z.object({
    text: z.string().min(1).optional(),
    isCorrect: z.boolean().optional(),
    position: z.number().int().positive().optional(),
  });

  app.put(
    "/options/:id",
    {
      id: "update-option",
      summary: "Update an option",
      description:
        "Changes the given fields of an answer option (400 when there is nothing to change). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Option id"),
        body: updateOptionSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("option") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateOptionSchema, input.body);
      if (valid instanceof Response) return valid;
      const optionId = c.req.param("id");
      const data = valid;
      // A body with no fields reached .set({}) and drizzle threw "No values to
      // set" → 500 (phase D, authorization matrix).
      if (Object.keys(data).length === 0) return c.json({ error: "Nothing to update" }, 400);

      const [option] = await dbInstance
        .update(optionTable)
        .set(data)
        .where(eq(optionTable.id, optionId))
        .returning();

      if (!option) {
        return c.json({ error: "Option not found" }, 404);
      }

      return c.json({ success: true, option });
    }
  );

  /**
   * DELETE /options/:id
   * Delete an option
   */
  app.delete(
    "/options/:id",
    {
      id: "delete-option",
      summary: "Delete an option",
      description:
        "Deletes an answer option. Cannot be undone. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Option id") },
      output: { schema: Done },
    },
    async (c) => {
      const optionId = c.req.param("id");

      await dbInstance.delete(optionTable).where(eq(optionTable.id, optionId));

      return c.json({ success: true, message: "Option deleted" });
    }
  );

  // ============================================
  // GROUPS - FULL CRUD (MISSING)
  // ============================================

  /**
   * GET /groups/:id
   * Get the detail of a group with members
   */
  app.get(
    "/groups/:id",
    {
      id: "get-group",
      summary: "Group detail",
      description:
        "Academy staff get the group with its members and extra supervisors; a member gets the group without them; anyone else gets a 404. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: ParamId("Group id") },
      output: { schema: z.object({ group: Row }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const actor = await actorOf(c);
      const groupId = c.req.param("id");

      const [group] = await dbInstance
        .select()
        .from(assignmentGroupTable)
        .where(eq(assignmentGroupTable.id, groupId))
        .limit(1);
      if (!group) {
        return c.json({ error: "Group not found" }, 404);
      }

      if (!managesAcademy(actor)) {
        // A member sees their group, not the list of peers or supervisors.
        const [isMember] = await dbInstance
          .select({ id: groupUserTable.id })
          .from(groupUserTable)
          .where(
            and(eq(groupUserTable.groupId, groupId), eq(groupUserTable.userId, actor.id!))
          )
          .limit(1);
        if (!isMember) return c.json({ error: "Group not found" }, 404);
        return c.json({
          group: {
            id: group.id,
            name: group.name,
            description: group.description,
            active: group.active,
          },
        });
      }

      const members = await dbInstance
        .select()
        .from(groupUserTable)
        .where(eq(groupUserTable.groupId, groupId));
      const additionalSupervisors = await dbInstance
        .select()
        .from(groupSupervisorTable)
        .where(eq(groupSupervisorTable.groupId, groupId));
      return c.json({ group: { ...group, members, additionalSupervisors } });
    }
  );

  /**
   * PUT /groups/:id
   * Update a group
   */
  const updateGroupSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    supervisorPrincipalId: z.string().optional().nullable(),
    active: z.boolean().optional(),
  });

  app.put(
    "/groups/:id",
    {
      id: "update-group",
      summary: "Update a group",
      description:
        "Changes the given fields of a group (name, description, main supervisor, active). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Group id"),
        body: updateGroupSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("group") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateGroupSchema, input.body);
      if (valid instanceof Response) return valid;
      const groupId = c.req.param("id");
      const data = valid;

      const [group] = await dbInstance
        .update(assignmentGroupTable)
        .set({
          ...data,
          updatedAt: new Date(),
        })
        .where(eq(assignmentGroupTable.id, groupId))
        .returning();

      if (!group) {
        return c.json({ error: "Group not found" }, 404);
      }

      return c.json({ success: true, group });
    }
  );

  /**
   * DELETE /groups/:id
   * Delete a group
   */
  app.delete(
    "/groups/:id",
    {
      id: "delete-group",
      summary: "Delete a group",
      description:
        "Deletes a group with its members and its group assignments. Cannot be undone. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Group id") },
      output: { schema: Done },
    },
    async (c) => {
      const groupId = c.req.param("id");

      await dbInstance.delete(assignmentGroupTable).where(eq(assignmentGroupTable.id, groupId));

      return c.json({ success: true, message: "Group deleted" });
    }
  );

  /**
   * DELETE /groups/:id/members/:userId
   * Remove a member from a group
   */
  app.delete(
    "/groups/:id/members/:userId",
    {
      id: "remove-group-member",
      summary: "Remove a member from a group",
      description: "Removes a user from a group. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: GroupAndUserParam },
      output: { schema: Done },
    },
    async (c) => {
      const groupId = c.req.param("id");
      const userId = c.req.param("userId");

      await dbInstance
        .delete(groupUserTable)
        .where(and(eq(groupUserTable.groupId, groupId), eq(groupUserTable.userId, userId)));

      return c.json({ success: true, message: "Member removed from the group" });
    }
  );

  /**
   * POST /groups/:id/supervisors
   * Add an additional supervisor to a group
   */
  const addSupervisorSchema = z.object({
    supervisorId: z.string(),
  });

  app.post(
    "/groups/:id/supervisors",
    {
      id: "add-group-supervisor",
      summary: "Add a supervisor to a group",
      description:
        "Adds an extra supervisor to a group (already there: no change). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Group id"),
        body: addSupervisorSchema,
        validatesHandler: true,
      },
      output: { schema: Done },
      errors: ["KITSUDEN_E_CONFLICT"],
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, addSupervisorSchema, input.body);
      if (valid instanceof Response) return valid;
      const groupId = c.req.param("id");
      const { supervisorId } = valid;

      await dbInstance
        .insert(groupSupervisorTable)
        .values({ groupId, supervisorId })
        .onConflictDoNothing();

      return c.json({ success: true, message: "Supervisor added" });
    }
  );

  /**
   * DELETE /groups/:id/supervisors/:supervisorId
   * Remove an additional supervisor
   */
  app.delete(
    "/groups/:id/supervisors/:supervisorId",
    {
      id: "remove-group-supervisor",
      summary: "Remove a supervisor from a group",
      description:
        "Removes an extra supervisor from a group. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: GroupAndSupervisorParam },
      output: { schema: Done },
    },
    async (c) => {
      const groupId = c.req.param("id");
      const supervisorId = c.req.param("supervisorId");

      await dbInstance
        .delete(groupSupervisorTable)
        .where(
          and(
            eq(groupSupervisorTable.groupId, groupId),
            eq(groupSupervisorTable.supervisorId, supervisorId)
          )
        );

      return c.json({ success: true, message: "Supervisor removed" });
    }
  );

  // ============================================
  // ASSIGNMENTS - FULL CRUD (MISSING)
  // ============================================

  /**
   * GET /assignments/:id
   * Get the detail of an assignment
   */
  app.get(
    "/assignments/:id",
    {
      id: "get-assignment",
      summary: "Assignment detail",
      description:
        "A course assignment with its course. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { params: ParamId("Assignment id") },
      output: { schema: z.object({ assignment: Row }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const assignmentId = c.req.param("id");

      const row = await first(dbInstance, assignmentTable, eq(assignmentTable.id, assignmentId));
      const [assignment] = row
        ? await withRelation(dbInstance, [row], "courseId", courseTable, "course")
        : [];

      if (!assignment) {
        return c.json({ error: "Assignment not found" }, 404);
      }

      return c.json({ assignment });
    }
  );

  /**
   * PUT /assignments/:id
   * Update an assignment
   */
  const updateAssignmentSchema = z.object({
    notes: z.string().optional(),
  });

  app.put(
    "/assignments/:id",
    {
      id: "update-assignment",
      summary: "Update an assignment",
      description:
        "Changes the notes of a course assignment (400 when there is nothing to change). Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: {
        params: ParamId("Assignment id"),
        body: updateAssignmentSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("assignment") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateAssignmentSchema, input.body);
      if (valid instanceof Response) return valid;
      const assignmentId = c.req.param("id");
      const data = valid;
      // A body with no fields reached .set({}) and drizzle threw "No values to
      // set" → 500 (phase D, authorization matrix).
      if (Object.keys(data).length === 0) return c.json({ error: "Nothing to update" }, 400);

      const [assignment] = await dbInstance
        .update(assignmentTable)
        .set(data)
        .where(eq(assignmentTable.id, assignmentId))
        .returning();

      if (!assignment) {
        return c.json({ error: "Assignment not found" }, 404);
      }

      return c.json({ success: true, assignment });
    }
  );

  /**
   * DELETE /assignments/:id
   * Delete an assignment
   */
  app.delete(
    "/assignments/:id",
    {
      id: "delete-assignment",
      summary: "Delete an assignment",
      description:
        "Deletes a course assignment (the student's progress stays). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Assignment id") },
      output: { schema: Done },
    },
    async (c) => {
      const assignmentId = c.req.param("id");

      await dbInstance.delete(assignmentTable).where(eq(assignmentTable.id, assignmentId));

      return c.json({ success: true, message: "Assignment deleted" });
    }
  );

  // ============================================
  // LEARNING PATHS - FULL CRUD (MISSING)
  // ============================================

  /**
   * DELETE /learning-paths/:id
   * Delete a learning path (soft delete)
   */
  app.delete(
    "/learning-paths/:id",
    {
      id: "deactivate-learning-path",
      summary: "Deactivate a learning path",
      description:
        "Soft-deletes a learning path: marks it inactive. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("Learning path id") },
      output: { schema: Done },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const pathId = c.req.param("id");

      const [path] = await dbInstance
        .update(learningPathTable)
        .set({ active: false, updatedAt: new Date() })
        .where(eq(learningPathTable.id, pathId))
        .returning();

      if (!path) {
        return c.json({ error: "Learning Path not found" }, 404);
      }

      return c.json({ success: true, message: "Learning Path deactivated" });
    }
  );

  /**
   * POST /learning-paths/:id/courses
   * Add a course to a learning path
   */
  const addCoursePathSchema = z.object({
    courseId: z.string(),
    position: z.number().int().positive(),
    required: z.boolean().default(true),
    estimatedDays: z.number().int().positive().optional(),
  });

  app.post(
    "/learning-paths/:id/courses",
    {
      id: "add-learning-path-course",
      summary: "Add a course to a learning path",
      description:
        "Adds a course to a learning path at the given position. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: ParamId("Learning path id"),
        body: addCoursePathSchema,
        validatesHandler: true,
      },
      output: { status: 201, schema: withRow("course") },
      errors: ["KITSUDEN_E_CONFLICT"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, addCoursePathSchema, input.body);
      if (valid instanceof Response) return valid;
      const pathId = c.req.param("id");
      const data = valid;

      const [coursePath] = await dbInstance
        .insert(learningPathCourseTable)
        .values({
          learningPathId: pathId,
          ...data,
        })
        .returning();

      return c.json({ success: true, course: coursePath }, 201);
    }
  );

  /**
   * PUT /learning-paths/:id/courses/:courseId
   * Update a course in a learning path
   */
  const updateCoursePathSchema = z.object({
    position: z.number().int().positive().optional(),
    required: z.boolean().optional(),
    estimatedDays: z.number().int().positive().optional().nullable(),
  });

  app.put(
    "/learning-paths/:id/courses/:courseId",
    {
      id: "update-learning-path-course",
      summary: "Update a course in a learning path",
      description:
        "Changes the order, the mandatory flag or the estimated days of a course in a learning path (400 when there is nothing to change). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: {
        params: PathAndCourseParam,
        body: updateCoursePathSchema,
        validatesHandler: true,
      },
      output: { schema: withRow("course") },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, updateCoursePathSchema, input.body);
      if (valid instanceof Response) return valid;
      const pathId = c.req.param("id");
      const courseId = c.req.param("courseId");
      const data = valid;
      // A body with no fields reached .set({}) and drizzle threw "No values to
      // set" → 500 (phase D, authorization matrix).
      if (Object.keys(data).length === 0) return c.json({ error: "Nothing to update" }, 400);

      const [coursePath] = await dbInstance
        .update(learningPathCourseTable)
        .set(data)
        .where(
          and(
            eq(learningPathCourseTable.learningPathId, pathId),
            eq(learningPathCourseTable.courseId, courseId)
          )
        )
        .returning();

      if (!coursePath) {
        return c.json({ error: "Course not found in the Learning Path" }, 404);
      }

      return c.json({ success: true, course: coursePath });
    }
  );

  /**
   * DELETE /learning-paths/:id/courses/:courseId
   * Remove a course from a learning path
   */
  app.delete(
    "/learning-paths/:id/courses/:courseId",
    {
      id: "remove-learning-path-course",
      summary: "Remove a course from a learning path",
      description:
        "Removes a course from a learning path. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: PathAndCourseParam },
      output: { schema: Done },
    },
    async (c) => {
      const pathId = c.req.param("id");
      const courseId = c.req.param("courseId");

      await dbInstance
        .delete(learningPathCourseTable)
        .where(
          and(
            eq(learningPathCourseTable.learningPathId, pathId),
            eq(learningPathCourseTable.courseId, courseId)
          )
        );

      return c.json({ success: true, message: "Course removed from the Learning Path" });
    }
  );

  /**
   * GET /learning-paths/:id/stats
   * Statistics of a learning path
   */
  app.get(
    "/learning-paths/:id/stats",
    {
      id: "get-learning-path-stats",
      summary: "Learning path statistics",
      description:
        "Assigned, completed, in progress and pending students, completion rate, average progress and number of courses of a learning path. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { params: ParamId("Learning path id") },
      output: { schema: z.object({ stats: Obj }).passthrough() },
    },
    async (c) => {
      const pathId = c.req.param("id");

      // Total users with the path assigned
      const [{ count: totalAssigned }] = await dbInstance
        .select({ count: count() })
        .from(learningPathProgressTable)
        .where(eq(learningPathProgressTable.learningPathId, pathId));

      // Completed
      const [{ count: completedItems }] = await dbInstance
        .select({ count: count() })
        .from(learningPathProgressTable)
        .where(
          and(
            eq(learningPathProgressTable.learningPathId, pathId),
            eq(learningPathProgressTable.completed, true)
          )
        );

      // In progress
      const [{ count: inProgress }] = await dbInstance
        .select({ count: count() })
        .from(learningPathProgressTable)
        .where(
          and(
            eq(learningPathProgressTable.learningPathId, pathId),
            eq(learningPathProgressTable.completed, false),
            gt(learningPathProgressTable.completionPercent, 0)
          )
        );

      // Average progress
      const [progressAvg] = await dbInstance
        .select({ avg: avg(learningPathProgressTable.completionPercent) })
        .from(learningPathProgressTable)
        .where(eq(learningPathProgressTable.learningPathId, pathId));

      // Total courses in the path
      const [{ count: totalCourses }] = await dbInstance
        .select({ count: count() })
        .from(learningPathCourseTable)
        .where(eq(learningPathCourseTable.learningPathId, pathId));

      return c.json({
        stats: {
          totalAssigned,
          completedItems,
          inProgress,
          pending: totalAssigned - completedItems - inProgress,
          finishRate:
            totalAssigned > 0 ? Math.round((completedItems / totalAssigned) * 100) : 0,
          averageProgress: Math.round(Number(progressAvg.avg ?? 0)),
          totalCourses,
        },
      });
    }
  );

  // ============================================
  // SURVEYS - FULL CRUD (MISSING)
  // ============================================

  // `/surveys/stats` goes BEFORE `/surveys/:id`.
  //
  // It used to come right after, so Hono resolved it through the wildcard with
  // id="stats": it looked for a survey with that UUID, did not find it and
  // returned 404 "Survey not found". The statistics were unreachable.
  // Guarded by the core's tests/unit/shadowed-routes.test.ts.
  /**
   * GET /surveys/stats
   * Global survey statistics
   */
  app.get(
    "/surveys/stats",
    {
      id: "get-survey-stats",
      summary: "Survey statistics",
      description:
        "Number of surveys, average satisfaction and speaker score, usefulness percentage and satisfaction distribution, optionally of one course. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { query: query({ courseId: text("Course id") }) },
      output: { schema: z.object({ stats: Obj }).passthrough() },
    },
    async (c) => {
      const courseId = c.req.query("courseId");

      const surveys = await dbInstance
        .select()
        .from(satisfactionSurveyTable)
        .where(courseId ? eq(satisfactionSurveyTable.courseId, courseId) : undefined);

      if (surveys.length === 0) {
        return c.json({
          stats: {
            total: 0,
            averageSatisfaction: 0,
            averagePresenter: 0,
            usefulnessPercent: 0,
          },
        });
      }

      const averageSatisfaction =
        surveys.reduce((sum: number, e: SatisfactionSurvey) => sum + e.satisfaction, 0) /
        surveys.length;
      const averageSpeaker =
        surveys.reduce((sum: number, e: SatisfactionSurvey) => sum + e.presenter, 0) /
        surveys.length;
      const usefulnessCount = surveys.filter((e) => e.usefulness).length;

      return c.json({
        stats: {
          total: surveys.length,
          averageSatisfaction: Math.round(averageSatisfaction * 10) / 10,
          averagePresenter: Math.round(averageSpeaker * 10) / 10,
          usefulnessPercent: Math.round((usefulnessCount / surveys.length) * 100),
          satisfactionDistribution: {
            five: surveys.filter((e) => e.satisfaction === 5).length,
            four: surveys.filter((e) => e.satisfaction === 4).length,
            three: surveys.filter((e) => e.satisfaction === 3).length,
            two: surveys.filter((e) => e.satisfaction === 2).length,
            one: surveys.filter((e) => e.satisfaction === 1).length,
          },
        },
      });
    }
  );

  /**
   * GET /surveys/:id
   * Get the detail of a survey
   */
  app.get(
    "/surveys/:id",
    {
      id: "get-survey",
      summary: "Survey detail",
      description:
        "A satisfaction survey with its course. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { params: ParamId("Survey id") },
      output: { schema: z.object({ survey: Row }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const surveyId = c.req.param("id");

      const row = await first(
        dbInstance,
        satisfactionSurveyTable,
        eq(satisfactionSurveyTable.id, surveyId)
      );
      const [survey] = row
        ? await withRelation(dbInstance, [row], "courseId", courseTable, "course")
        : [];

      if (!survey) {
        return c.json({ error: "Survey not found" }, 404);
      }

      return c.json({ survey });
    }
  );

  // ============================================
  // REPORTS AND ANALYTICS
  // ============================================

  /**
   * GET /reports/courses
   * Course report with metrics
   */
  app.get(
    "/reports/courses",
    {
      id: "courses-report",
      summary: "Course report",
      description:
        "For each active course (or only courseId): assignments, completions, average progress, completion rate and survey satisfaction. dateFrom/dateTo are accepted but not applied. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: {
        query: query({
          courseId: text("Course id"),
          dateFrom: text("Not applied"),
          dateTo: text("Not applied"),
        }),
      },
      output: { schema: listing("reports", Obj) },
    },
    async (c) => {
      const courseId = c.req.query("courseId");
      const dateFrom = c.req.query("dateFrom");
      const dateTo = c.req.query("dateTo");

      // Base query for courses
      let coursesQuery = dbInstance.select().from(courseTable).where(eq(courseTable.active, true));

      if (courseId) {
        coursesQuery = dbInstance.select().from(courseTable).where(eq(courseTable.id, courseId));
      }

      const courses = await coursesQuery;

      const reports = await inSeries(courses, async (course: Course) => {
        // Assignments
        const [{ count: assignments }] = await dbInstance
          .select({ count: count() })
          .from(assignmentTable)
          .where(eq(assignmentTable.courseId, course.id));

        // Progress
        const progressRows = await dbInstance
          .select({
            completedItems: count(),
            average: avg(courseProgressTable.progressPercent),
          })
          .from(courseProgressTable)
          .where(eq(courseProgressTable.courseId, course.id));

        // Surveys
        const surveys = await dbInstance
          .select({
            total: count(),
            satisfaction: avg(satisfactionSurveyTable.satisfaction),
          })
          .from(satisfactionSurveyTable)
          .where(eq(satisfactionSurveyTable.courseId, course.id));

        return {
          course: {
            id: course.id,
            title: course.title,
            type: course.courseType,
          },
          metrics: {
            assignments,
            completedItems: Number(progressRows[0]?.completedItems ?? 0),
            averageProgress: Math.round(Number(progressRows[0]?.average ?? 0)),
            finishRate:
              assignments > 0
                ? Math.round((Number(progressRows[0]?.completedItems ?? 0) / assignments) * 100)
                : 0,
            totalSurveys: Number(surveys[0]?.total ?? 0),
            averageSatisfaction: Math.round(Number(surveys[0]?.satisfaction ?? 0) * 10) / 10,
          },
        };
      });

      return c.json({
        reports,
        total: reports.length,
      });
    }
  );

  /**
   * GET /reports/users/:id
   * Detailed report of a user
   */
  app.get(
    "/reports/users/:id",
    {
      id: "user-report",
      summary: "Report of one student",
      description:
        "A student's assigned courses with progress and quiz results, learning paths, certificates and a summary. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { params: ParamId("User id") },
      output: {
        schema: z
          .object({
            userId: z.string(),
            summary: Obj,
            progresses: z.array(Obj),
            learningPaths: z.array(Obj),
            certificates: z.array(Obj),
          })
          .passthrough(),
      },
    },
    async (c) => {
      const userId = c.req.param("id");

      // Assigned courses
      const assignments = await withRelation(
        dbInstance,
        await all(dbInstance, assignmentTable, eq(assignmentTable.userId, userId)),
        "courseId",
        courseTable,
        "course"
      );

      // Progress in each course
      const progressRows = await inSeries(assignments, async (assignment) => {
        const courseRel = assignment.course;
        const progress = await first(
          dbInstance,
          courseProgressTable,
          and(
            eq(courseProgressTable.userId, userId),
            eq(courseProgressTable.courseId, assignment.courseId)
          )
        );

        // Quiz results
        const quizResults = await dbInstance
          .select({
            quizId: quizResultTable.quizId,
            score: quizResultTable.scorePercent,
            passed: quizResultTable.passed,
            date: quizResultTable.takenAt,
          })
          .from(quizResultTable)
          .innerJoin(quizTable, eq(quizResultTable.quizId, quizTable.id))
          .innerJoin(moduleTable, eq(quizTable.moduleId, moduleTable.id))
          .where(
            and(eq(quizResultTable.userId, userId), eq(moduleTable.courseId, assignment.courseId))
          );

        return {
          course: courseRel,
          progress,
          quizzes: quizResults,
        };
      });

      // Learning paths
      const paths = await withRelation(
        dbInstance,
        await all(
          dbInstance,
          learningPathProgressTable,
          eq(learningPathProgressTable.userId, userId)
        ),
        "learningPathId",
        learningPathTable,
        "learningPath"
      );

      // Certificates
      const certificates = await dbInstance
        .select({
          code: certificateTable.code,
          courseId: certificateTable.courseId,
          generatedAt: certificateTable.generatedAt,
        })
        .from(certificateTable)
        .where(eq(certificateTable.userId, userId));

      return c.json({
        userId,
        summary: {
          totalAssignedCourses: assignments.length,
          completedCourses: progressRows.filter((p) => p.progress?.completed).length,
          coursesInProgress: progressRows.filter(
            (p) => !p.progress?.completed && (p.progress?.progressPercent ?? 0) > 0
          ).length,
          assignedLearningPaths: paths.length,
          completedLearningPaths: paths.filter((p) => p.completed).length,
          totalCertificates: certificates.length,
        },
        progresses: progressRows,
        learningPaths: paths,
        certificates,
      });
    }
  );

  /**
   * GET /reports/progress
   * Global progress report
   */
  app.get(
    "/reports/progress",
    {
      id: "progress-report",
      summary: "Progress report",
      description:
        "Course progress rows (with their course), most recently updated first, filtered by courseId and/or the members of groupId. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { query: query({ courseId: text("Course id"), groupId: text("Group id") }) },
      output: { schema: listing("progresses") },
    },
    async (c) => {
      const courseId = c.req.query("courseId");
      const groupId = c.req.query("groupId");

      let userIds: string[] = [];

      // If a group is specified, get the group's users
      if (groupId) {
        const members = await dbInstance
          .select({ userId: groupUserTable.userId })
          .from(groupUserTable)
          .where(eq(groupUserTable.groupId, groupId));
        userIds = members.map((m: { userId: string }) => m.userId);

        if (userIds.length === 0) {
          return c.json({ progresses: [], total: 0 });
        }
      }

      // Fourth instance of the chained .where() bug (it replaces, it does not
      // accumulate): with course AND users, only the users filter was applied.
      const conditions = [
        courseId ? eq(courseProgressTable.courseId, courseId) : undefined,
        userIds.length > 0 ? inArray(courseProgressTable.userId, userIds) : undefined,
      ].filter((f) => f !== undefined);

      const progressRows = await dbInstance
        .select()
        .from(courseProgressTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(courseProgressTable.updatedAt));

      // Enrich with course info
      const progressWithInfo = await inSeries(progressRows, async (p: CourseProgress) => {
        const course = await first(dbInstance, courseTable, eq(courseTable.id, p.courseId));

        return {
          ...p,
          course,
        };
      });

      return c.json({
        progresses: progressWithInfo,
        total: progressWithInfo.length,
      });
    }
  );

  // ============================================
  // USER PROFILES (TRAINING)
  // ============================================

  /**
   * GET /profiles
   * List user profiles of the training system
   */
  app.get(
    "/profiles",
    {
      id: "list-profiles",
      summary: "List academy profiles",
      description:
        "Academy profiles (user id, academy role, active), newest first, optionally of one role. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: {
        query: query({
          role: z.enum(trainingRoleEnum.enumValues).optional().describe("Academy role"),
        }),
      },
      output: { schema: listing("profiles") },
    },
    async (c) => {
      const role = c.req.query("role");

      const profiles = await dbInstance
        .select()
        .from(userProfileTable)
        .where(
          role
            ? eq(
                userProfileTable.trainingRole,
                role as (typeof userProfileTable.trainingRole)["enumValues"][number]
              )
            : undefined
        )
        .orderBy(desc(userProfileTable.createdAt));

      return c.json({ profiles, total: profiles.length });
    }
  );

  /**
   * POST /profiles
   * Create user profile
   */
  const createProfileSchema = z.object({
    userId: z.string(),
    trainingRole: z.enum(trainingRoleEnum.enumValues).default("student"),
    notes: z.string().optional(),
  });

  app.post(
    "/profiles",
    {
      id: "create-profile",
      summary: "Create or update an academy profile",
      description:
        "Creates the academy profile of a user, or updates its role and notes if it exists. The academy role decides what the user may manage here. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: createProfileSchema, validatesHandler: true },
      output: { status: 201, schema: withRow("profile") },
      sensitive: true,
      idempotent: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, createProfileSchema, input.body);
      if (valid instanceof Response) return valid;
      const data = valid;

      const [profile] = await dbInstance
        .insert(userProfileTable)
        .values(data)
        .onConflictDoUpdate({
          target: userProfileTable.userId,
          set: {
            trainingRole: data.trainingRole,
            notes: data.notes,
            updatedAt: new Date(),
          },
        })
        .returning();

      return c.json({ success: true, profile }, 201);
    }
  );

  /**
   * PUT /profiles/:id/role
   * Change a user's role
   */
  const changeRoleSchema = z.object({
    role: z.enum(trainingRoleEnum.enumValues),
  });

  app.put(
    "/profiles/:id/role",
    {
      id: "change-profile-role",
      summary: "Change a user's academy role",
      description:
        "Sets the academy role (administrator, supervisor, student) of a user, creating the profile if needed. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { params: ParamId("User id"), body: changeRoleSchema, validatesHandler: true },
      output: { schema: withRow("profile") },
      sensitive: true,
    },
    async (c, input) => {
      const valid = await validatedAsBefore(c, changeRoleSchema, input.body);
      if (valid instanceof Response) return valid;
      const userId = c.req.param("id");
      const { role } = valid;

      const [profile] = await dbInstance
        .insert(userProfileTable)
        .values({
          userId,
          trainingRole: role,
          roleAssignedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: userProfileTable.userId,
          set: {
            trainingRole: role,
            roleAssignedAt: new Date(),
            updatedAt: new Date(),
          },
        })
        .returning();

      return c.json({ success: true, profile });
    }
  );

  // ============================================
  // CERTIFICATES WITH PDF
  // ============================================

  /**
   * GET /certificates/:courseId/pdf
   * Download certificate as PDF
   */
  app.get(
    "/certificates/:courseId/pdf",
    {
      id: "download-certificate-pdf",
      summary: "Download my certificate (PDF)",
      description:
        "Your certificate of a course as a PDF file, once you completed the course and its survey (403 otherwise). Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { params: CourseParam },
      output: { type: "application/pdf", description: "The certificate PDF (attachment)" },
      errors: ["KITSUDEN_E_NOT_FOUND"],
      mcp: { exclude: "returns PDF bytes" },
    },
    async (c) => {
      const user = requireUser(c);
      if (!user) {
        return c.json({ error: "Not authenticated" }, 401);
      }
      const courseId = c.req.param("courseId");

      // A course that does not exist is a 404, not a "not eligible" (403): 403 is
      // for authorization, and the matrix reads it that way (phase D).
      if (!(await first(dbInstance, courseTable, eq(courseTable.id, courseId)))) {
        return c.json({ error: "Course not found" }, 404);
      }

      // Check that the course is completed and the survey done
      const progress = await first(
        dbInstance,
        courseProgressTable,
        and(
          eq(courseProgressTable.userId, user.id),
          eq(courseProgressTable.courseId, courseId),
          eq(courseProgressTable.completed, true),
          eq(courseProgressTable.surveyCompleted, true)
        )
      );

      if (!progress) {
        return c.json(
          {
            error:
              "Not eligible for a certificate. You must complete the course and the satisfaction survey.",
          },
          403
        );
      }

      const course = await first(dbInstance, courseTable, eq(courseTable.id, courseId));

      if (!course) {
        return c.json({ error: "Course not found" }, 404);
      }

      // Generate or retrieve code
      const certificate = await first(
        dbInstance,
        certificateTable,
        and(eq(certificateTable.userId, user.id), eq(certificateTable.courseId, courseId))
      );

      let code: string;
      if (certificate) {
        code = certificate.code;
      } else {
        code = certificateCode();
      }

      // Generate PDF
      const certData: CertificateData = {
        userName: user.name || user.email || user.id,
        courseName: course.title,
        completedAt: progress.completedAt || new Date(),
        durationHours: course.durationHours || "N/A",
        code,
      };

      try {
        const pdfBuffer = await generateCertificatePdf(certData, {
          type: "generated",
          primaryColor: course.coverColor || "#009c3c",
        });

        // Create or update certificate in the DB
        if (!certificate) {
          await dbInstance.insert(certificateTable).values({
            userId: user.id,
            courseId,
            code,
            dataJson: {
              userName: user.name,
              courseName: course.title,
              completedAt: progress.completedAt,
              durationHours: course.durationHours,
            },
          });
        }

        await dbInstance
          .update(courseProgressTable)
          .set({
            certificateDownloaded: true,
            certificateDownloadedAt: new Date(),
          })
          .where(
            and(eq(courseProgressTable.userId, user.id), eq(courseProgressTable.courseId, courseId))
          );

        // Record activity
        await dbInstance.insert(activityLogTable).values({
          userId: user.id,
          type: "certificate_downloaded",
          entityType: "course",
          entityId: courseId,
          description: `Certificate downloaded for course: ${course.title}`,
        });

        // Return PDF
        c.header("Content-Type", "application/pdf");
        c.header(
          "Content-Disposition",
          `attachment; filename="certificate-${course.title.replace(/\s+/g, "_")}.pdf"`
        );

        return c.body(pdfBuffer as any);
      } catch (error) {
        return c.json({ error: "Error generating PDF certificate" }, 500);
      }
    }
  );

  /**
   * GET /certificates/verify/:code
   * Verify the authenticity of a certificate
   */
  app.get(
    "/certificates/verify/:code",
    {
      id: "verify-certificate",
      summary: "Verify a certificate",
      description:
        "Public: checks a certificate code and returns the course, issue date and data of the certificate. Anyone holding the code may verify it, no account needed. An invalid code is a 400, an unknown one a 404.",
      access: "public",
      input: { params: CodeParam },
      output: { schema: z.object({ valid: z.literal(true), certificate: Obj }).passthrough() },
      errors: ["KITSUDEN_E_NOT_FOUND"],
    },
    async (c) => {
      const code = c.req.param("code");

      if (!validateCertificateCode(code)) {
        return c.json({ valid: false, error: "Invalid certificate code" }, 400);
      }

      // Verifying a certificate is public on purpose: it is done by whoever receives
      // the code (a company, a third party), not its owner. What authorizes it is
      // having the CODE, and the RLS of `certificates` (by owner) does not know that:
      // as the system, looking up only by that code.
      const certificate = await asSystem(async () => {
        const row = await first(
          dbInstance,
          certificateTable,
          eq(certificateTable.code, code)
        );
        return row
          ? (await withRelation(dbInstance, [row], "courseId", courseTable, "course"))[0]
          : null;
      });

      if (!certificate) {
        return c.json({ valid: false, error: "Certificate not found" }, 404);
      }

      return c.json({
        valid: true,
        certificate: {
          code: certificate.code,
          // The `with` union without relations(): at runtime it is an object.
          course: (certificate.course as { title?: string } | null)?.title,
          generatedAt: certificate.generatedAt,
          data: certificate.dataJson,
        },
      });
    }
  );

  // ============================================
  // EXCEL EXPORT
  // ============================================

  /**
   * GET /export/assignments
   * Export assignments to Excel
   */
  app.get(
    "/export/assignments",
    {
      id: "export-assignments",
      summary: "Export assignments (Excel)",
      description:
        "Course assignments with their progress as an .xlsx file, filtered by courseId and/or groupId. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: {
        query: query({
          courseId: text("Course id"),
          groupId: text("Group id"),
          dateFrom: text("Not applied"),
          dateTo: text("Not applied"),
        }),
      },
      output: { type: XLSX_TYPE, description: "Excel workbook (attachment)" },
      mcp: { exclude: "returns an Excel file" },
    },
    async (c) => {
      const courseId = c.req.query("courseId");
      const groupId = c.req.query("groupId");
      const dateFrom = c.req.query("dateFrom");
      const dateTo = c.req.query("dateTo");

      // Fifth instance of the chained .where() bug.
      const exportConditions = [
        courseId ? eq(assignmentTable.courseId, courseId) : undefined,
        groupId ? eq(assignmentTable.groupId, groupId) : undefined,
      ].filter((f) => f !== undefined);

      const assignments = await dbInstance
        .select()
        .from(assignmentTable)
        .where(exportConditions.length > 0 ? and(...exportConditions) : undefined)
        .orderBy(desc(assignmentTable.date));

      // Prepare data for Excel
      const data = await inSeries(assignments, async (assign: Assignment) => {
        const course = await first(dbInstance, courseTable, eq(courseTable.id, assign.courseId));

        const progress = assign.userId
          ? await first(
              dbInstance,
              courseProgressTable,
              and(
                eq(courseProgressTable.userId, assign.userId),
                eq(courseProgressTable.courseId, assign.courseId)
              )
            )
          : null;

        const group = assign.groupId
          ? await first(
              dbInstance,
              assignmentGroupTable,
              eq(assignmentGroupTable.id, assign.groupId)
            )
          : null;

        return {
          date: assign.date ?? new Date(0),
          course: course?.title || "Course deleted",
          courseType: course?.courseType || "N/A",
          durationHours: course?.durationHours ?? 0,
          user: assign.userId || "Group",
          employeeNumber: undefined,
          group: group?.name ?? undefined,
          method: assign.method,
          progress: progress?.progressPercent || 0,
          finishedAt: progress?.completedAt,
          status: progress?.completed
            ? "Completed"
            : progress && progress.progressPercent > 0
              ? "In Progress"
              : "Not Started",
        };
      });

      try {
        const excelBuffer = await generateAssignmentsExcel(data, "Assignment History");

        c.header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        c.header(
          "Content-Disposition",
          `attachment; filename="assignments-${new Date().toISOString().split("T")[0]}.xlsx"`
        );

        return c.body(excelBuffer as any);
      } catch (error) {
        return c.json({ error: "Error generating Excel" }, 500);
      }
    }
  );

  /**
   * GET /export/progress
   * Export progress to Excel
   */
  app.get(
    "/export/progress",
    {
      id: "export-progress",
      summary: "Export progress (Excel)",
      description:
        "Course progress with topics and quizzes done as an .xlsx file, filtered by courseId and/or the members of groupId. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { query: query({ courseId: text("Course id"), groupId: text("Group id") }) },
      output: { type: XLSX_TYPE, description: "Excel workbook (attachment)" },
      mcp: { exclude: "returns an Excel file" },
    },
    async (c) => {
      const courseId = c.req.query("courseId");
      const groupId = c.req.query("groupId");

      // Get users if there is a group filter
      let userIds: string[] = [];
      if (groupId) {
        const members = await dbInstance
          .select({ userId: groupUserTable.userId })
          .from(groupUserTable)
          .where(eq(groupUserTable.groupId, groupId));
        userIds = members.map((m: { userId: string }) => m.userId);
      }

      // Sixth instance of the chained .where() bug.
      const progressFilters = [
        courseId ? eq(courseProgressTable.courseId, courseId) : undefined,
        userIds.length > 0 ? inArray(courseProgressTable.userId, userIds) : undefined,
      ].filter((f) => f !== undefined);

      const progressRows = await dbInstance
        .select()
        .from(courseProgressTable)
        .where(progressFilters.length > 0 ? and(...progressFilters) : undefined);

      // Prepare data
      const data = await inSeries(progressRows, async (prog: CourseProgress) => {
        const course = await first(dbInstance, courseTable, eq(courseTable.id, prog.courseId));

        const totalTopics = await dbInstance
          .select({ count: count() })
          .from(topicTable)
          .innerJoin(moduleTable, eq(topicTable.moduleId, moduleTable.id))
          .where(eq(moduleTable.courseId, prog.courseId));

        const completedTopics = await dbInstance
          .select({ count: count() })
          .from(topicProgressTable)
          .where(
            and(eq(topicProgressTable.userId, prog.userId), eq(topicProgressTable.completed, true))
          );

        const totalQuizzes = await dbInstance
          .select({ count: count() })
          .from(quizTable)
          .innerJoin(moduleTable, eq(quizTable.moduleId, moduleTable.id))
          .where(eq(moduleTable.courseId, prog.courseId));

        const passedQuizzes = await dbInstance
          .select({ count: count() })
          .from(quizResultTable)
          .innerJoin(quizTable, eq(quizResultTable.quizId, quizTable.id))
          .innerJoin(moduleTable, eq(quizTable.moduleId, moduleTable.id))
          .where(
            and(
              eq(quizResultTable.userId, prog.userId),
              eq(moduleTable.courseId, prog.courseId),
              eq(quizResultTable.passed, true)
            )
          );

        return {
          user: prog.userId,
          email: undefined,
          course: course?.title || "Course deleted",
          module: undefined,
          completedTopics: completedTopics[0]?.count || 0,
          totalTopics: totalTopics[0]?.count || 0,
          passedQuizzes: passedQuizzes[0]?.count || 0,
          totalQuizzes: totalQuizzes[0]?.count || 0,
          progressPercent: prog.progressPercent,
          status: prog.completed
            ? "Completed"
            : prog.progressPercent > 0
              ? "In Progress"
              : "Not Started",
          startDate: prog.createdAt ?? undefined,
          completedAt: prog.completedAt ?? undefined,
        };
      });

      try {
        const excelBuffer = await generateProgressExcel(data, "Progress Report");

        c.header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        c.header(
          "Content-Disposition",
          `attachment; filename="progress-${new Date().toISOString().split("T")[0]}.xlsx"`
        );

        return c.body(excelBuffer as any);
      } catch (error) {
        return c.json({ error: "Error generating Excel" }, 500);
      }
    }
  );

  /**
   * GET /export/surveys
   * Export surveys to Excel
   */
  app.get(
    "/export/surveys",
    {
      id: "export-surveys",
      summary: "Export surveys (Excel)",
      description:
        "Satisfaction surveys as an .xlsx file, optionally of one course. Academy admins and supervisors (or a global admin) only.",
      access: "session",
      permission: MANAGE,
      before: [withAcademyRole],
      input: { query: query({ courseId: text("Course id") }) },
      output: { type: XLSX_TYPE, description: "Excel workbook (attachment)" },
      mcp: { exclude: "returns an Excel file" },
    },
    async (c) => {
      const courseId = c.req.query("courseId");

      const surveys = await dbInstance
        .select()
        .from(satisfactionSurveyTable)
        .where(courseId ? eq(satisfactionSurveyTable.courseId, courseId) : undefined)
        .orderBy(desc(satisfactionSurveyTable.date));

      // Prepare data
      const data = await inSeries(surveys, async (enc: SatisfactionSurvey) => {
        const course = enc.courseId
          ? await first(dbInstance, courseTable, eq(courseTable.id, enc.courseId))
          : null;

        return {
          date: enc.date ?? new Date(0),
          course: course?.title || "Course deleted",
          user: enc.userId || "Anonymous",
          department: enc.department,
          jobTitle: enc.jobTitle,
          presenter: enc.presenter,
          usefulness: enc.usefulness ? "Yes" : "No",
          satisfaction: enc.satisfaction,
          learned: enc.learned,
          place: enc.place,
          role: enc.role,
          recommendation: enc.recommendation ?? undefined,
          comments: enc.courseComments,
        };
      });

      try {
        const excelBuffer = await generateSurveysExcel(data, "Survey Results");

        c.header(
          "Content-Type",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
        c.header(
          "Content-Disposition",
          `attachment; filename="surveys-${new Date().toISOString().split("T")[0]}.xlsx"`
        );

        return c.body(excelBuffer as any);
      } catch (error) {
        return c.json({ error: "Error generating Excel" }, 500);
      }
    }
  );

  // ============================================
  // USER SYNCHRONIZATION
  // ============================================

  /**
   * Where a sync writes: the academy profiles, and the host's account lookup (a kon cannot read
   * `auth_users`; `usersById` answers only for ids that exist).
   */
  const syncStore: SyncStore = {
    existingAccounts: async (ids) => {
      if (ids.length === 0) return new Set();
      const found = await ctx.auth.usersById(ids);
      return new Set(found.keys());
    },
    hasProfile: async (userId) => {
      const [row] = await dbInstance
        .select({ id: userProfileTable.id })
        .from(userProfileTable)
        .where(eq(userProfileTable.userId, userId))
        .limit(1);
      return Boolean(row);
    },
    createProfile: async (p) => {
      await dbInstance.insert(userProfileTable).values({
        userId: p.userId,
        trainingRole: p.trainingRole,
        active: p.active,
        notes: p.notes,
        roleAssignedAt: new Date(),
      });
    },
    updateProfile: async (p) => {
      await dbInstance
        .update(userProfileTable)
        .set({
          trainingRole: p.trainingRole,
          active: p.active,
          notes: p.notes,
          roleAssignedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userProfileTable.userId, p.userId));
    },
  };

  /** The sync options of the body: only the ones a sync applies; 400 if they are malformed. */
  const SyncOptions = syncConfigSchema
    .pick({ createNewUsers: true, updateExisting: true, roleMapping: true })
    .partial();

  /**
   * POST /sync/users
   * Create or update the academy profiles of existing accounts (JSON)
   */
  app.post(
    "/sync/users",
    {
      id: "sync-users",
      summary: "Sync academy profiles from external users",
      description:
        "Creates or updates the academy profile (role, active flag) of each listed user. Each row names an existing account by userId (or externalId when it is the account id); a kon cannot create accounts, so a row whose account does not exist is reported in result.errors and writes nothing. The role is the row's role when it is an academy role, else config.roleMapping, else student. config.createNewUsers / config.updateExisting (default true) skip creating or updating. 400 if any row is invalid (nothing is written). Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      input: { body: SyncUsers },
      output: {
        schema: z
          .object({ success: z.literal(true), message: z.string(), result: Obj })
          .passthrough(),
      },
      sensitive: true,
    },
    async (c, input) => {
      const body = input.body ?? {};
      const { users, config } = body;

      if (!Array.isArray(users) || users.length === 0) {
        return c.json({ error: "You must provide an array of users" }, 400);
      }

      const options = SyncOptions.safeParse(config ?? {});
      if (!options.success) {
        return c.json({ error: "Invalid sync config", details: options.error.issues }, 400);
      }

      const { valid: validValue, invalid } = validateExternalUsers(users);

      if (invalid.length > 0) {
        return c.json(
          {
            error: "Some users have invalid data",
            invalid: invalid.slice(0, 10),
            totalInvalid: invalid.length,
          },
          400
        );
      }

      const result = await syncUsers(
        validValue,
        options.data as Partial<SyncConfig>,
        syncStore
      );

      return c.json({
        success: true,
        message: `Synced ${result.successful} users (${result.created} created, ${result.updated} updated, ${result.failed} failed)`,
        result,
      });
    }
  );

  /**
   * POST /sync/users/csv
   * The same from a CSV body
   */
  app.post(
    "/sync/users/csv",
    {
      id: "sync-users-csv",
      summary: "Sync academy profiles from a CSV",
      description:
        "Same as sync-users with a raw CSV request body (header row first; columns externalId, userId, email, name, role…). Valid rows are synced with the default options; invalid rows are reported and skipped. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      output: {
        schema: z.object({ success: z.literal(true), message: z.string() }).passthrough(),
      },
      errors: ["KITSUDEN_E_BAD_REQUEST"],
      sensitive: true,
      mcp: { exclude: "takes a raw text/csv request body" },
    },
    async (c) => {
      const body = await c.req.text();

      if (!body || body.trim().length === 0) {
        return c.json({ error: "Empty CSV" }, 400);
      }

      let users;
      try {
        users = parseCsv(body);
      } catch (error) {
        return c.json(
          {
            error: "Error processing CSV",
            details: error instanceof Error ? error.message : "Unknown error",
          },
          400
        );
      }
      const { valid: validValue, invalid } = validateExternalUsers(users);
      const result = await syncUsers(validValue, {}, syncStore);

      return c.json({
        success: true,
        message: `CSV processed: ${validValue.length} valid users, ${invalid.length} invalid; ${result.created} created, ${result.updated} updated, ${result.failed} failed`,
        validUsers: validValue.length,
        invalidUsers: invalid.length,
        invalidDetails: invalid.slice(0, 5),
        result,
      });
    }
  );

  /**
   * GET /sync/role-mapping
   * Get the available role mapping
   */
  app.get(
    "/sync/role-mapping",
    {
      id: "get-role-mapping",
      summary: "Role mapping for user sync",
      description:
        "The example mapping from external roles to academy roles and the available academy roles. Academy administrators (or a global admin) only.",
      access: "session",
      permission: ADMINISTER,
      before: [withAcademyRole],
      output: {
        schema: z.object({ mappings: Obj, availableRoles: z.array(z.string()) }).passthrough(),
      },
    },
    async (c) => {
      return c.json({
        mappings: {
          example: exampleRoleMapping,
        },
        availableRoles: ["administrator", "supervisor", "student"],
      });
    }
  );

  // ============================================
  // MEDIA LIBRARY INTEGRATION
  // ============================================

  /**
   * POST /media/validate
   * Validate file before uploading
   */
  app.post(
    "/media/validate",
    {
      id: "validate-file",
      summary: "Check a file before uploading",
      description:
        "Checks a file's size and MIME type against the limits of its kind (image, video, document, audio, any). Returns the detected kind and readable size, or 400 with the reasons. Uploads nothing. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: ValidateFile },
      output: {
        schema: z
          .object({
            valid: z.literal(true),
            detectedType: z.string(),
            formattedSize: z.string(),
          })
          .passthrough(),
      },
      readOnly: true,
    },
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const { fileName, fileSize, mimeType, type } = body;

      const validation = validateFile({ name: fileName, size: fileSize, type: mimeType }, type);

      if (!validation.valid) {
        return c.json({ valid: false, errors: (validation as any).errors }, 400);
      }

      return c.json({
        valid: true,
        detectedType: determineMediaType(mimeType),
        formattedSize: formatBytes(fileSize),
      });
    }
  );

  /**
   * POST /media/youtube-info
   * Extract video information from YouTube
   */
  app.post(
    "/media/youtube-info",
    {
      id: "youtube-video-info",
      summary: "Parse a YouTube URL",
      description:
        "Extracts the video id, embed URL and thumbnail URL from a YouTube link (400 if it is not one). No call to YouTube. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: WithUrl },
      output: {
        schema: z
          .object({
            valid: z.literal(true),
            videoId: z.string(),
            embedUrl: z.string(),
            thumbnailUrl: z.string(),
          })
          .passthrough(),
      },
      readOnly: true,
    },
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const { url } = body;

      if (typeof url !== "string" || !url || url.length > 2000) {
        return c.json({ error: "URL required" }, 400);
      }

      const info = extractYoutubeInfo(url);

      if (!info.valid) {
        return c.json({ error: "Invalid YouTube URL" }, 400);
      }

      return c.json({
        valid: true,
        videoId: info.videoId,
        embedUrl: info.embedUrl,
        thumbnailUrl: info.thumbnailUrl,
      });
    }
  );

  /**
   * POST /media/normalize-video
   * Normalize video URL
   */
  app.post(
    "/media/normalize-video",
    {
      id: "normalize-video-url",
      summary: "Normalize a video URL",
      description:
        "Turns a YouTube, Vimeo or direct video link into its embeddable form, with its kind and thumbnail when known. No network call. Any signed-in account (an agent needs user:act or an academy-lms scope).",
      access: "session",
      permission: ANY_ACCOUNT,
      input: { body: WithUrl },
      output: { schema: z.object({ type: z.string(), url: z.string() }).passthrough() },
      readOnly: true,
    },
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const { url } = body;

      if (typeof url !== "string" || !url || url.length > 2000) {
        return c.json({ error: "URL required" }, 400);
      }

      const resultValue = normalizeVideoUrl(url);

      return c.json(resultValue);
    }
  );

  return app.ops;
}

/** The operations router (what the kon and the tests mount). */
export function createAcademyLMSRoutes(ctx: KonContext): Hono {
  return operationsRouter(KON_ID, academyOperations(ctx), ctx);
}

// Legacy export maintained for compatibility
// Use createAcademyLMSRoutes(ctx) instead
export { createAcademyLMSRoutes as academyLMSRoutes };
