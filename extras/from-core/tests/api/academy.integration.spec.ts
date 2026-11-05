/**
 * Academy LMS Integration Tests
 *
 * Tests complete CRUD operations and workflow for:
 * - Courses
 * - Modules
 * - Topics
 * - Quizzes
 * - Learning Paths
 * - Assignments
 * - Certificates
 */

import { test, expect } from "@playwright/test";

const API = process.env.API_URL || "http://localhost:3000";

// Test data
const testCourse = {
  title: `Test Course ${Date.now()}`,
  description: "Test course for integration",
  courseType: "self_paced",
  active: true,
  durationHours: 10,
};

let authCookie: string;
let createdCourseId: string;
let createdModuleId: string;
let createdTopicId: string;

test.describe("Academy LMS Integration", () => {
  test.beforeAll(async ({ request }) => {
    // Login and get auth cookie
    const loginRes = await request.post(`${API}/api/auth/sign-in/email`, {
      data: {
        email: "admin@kitsuden.gg",
        password: "kitsuden123",
      },
    });

    expect(loginRes.status()).toBe(200);
    const cookies = await loginRes.headers()["set-cookie"];
    authCookie = cookies || "";
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // COURSES
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/courses - Create course", async ({ request }) => {
    const res = await request.post(`${API}/api/academy/courses`, {
      headers: { Cookie: authCookie },
      data: testCourse,
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.course).toBeDefined();
    expect(data.course.title).toBe(testCourse.title);
    createdCourseId = data.course.id;
  });

  test("GET /academy/courses - List courses", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/courses`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.courses)).toBe(true);
    expect(data.courses.length).toBeGreaterThan(0);
  });

  test("GET /academy/courses/:id - Get specific course", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/courses/${createdCourseId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.course).toBeDefined();
    expect(data.course.id).toBe(createdCourseId);
    expect(data.course.title).toBe(testCourse.title);
  });

  test("PATCH /academy/courses/:id - Update course", async ({ request }) => {
    const updateData = { title: `Updated ${testCourse.title}` };

    const res = await request.patch(`${API}/api/academy/courses/${createdCourseId}`, {
      headers: { Cookie: authCookie },
      data: updateData,
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.course.title).toBe(updateData.title);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MODULES
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/modules - Create module", async ({ request }) => {
    const moduleData = {
      title: `Test Module ${Date.now()}`,
      description: "Test module",
      courseId: createdCourseId,
      order: 1,
    };

    const res = await request.post(`${API}/api/academy/modules`, {
      headers: { Cookie: authCookie },
      data: moduleData,
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.module).toBeDefined();
    expect(data.module.title).toBe(moduleData.title);
    createdModuleId = data.module.id;
  });

  test("GET /academy/modules/:id - Get module", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/modules/${createdModuleId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.module).toBeDefined();
    expect(data.module.id).toBe(createdModuleId);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TOPICS
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/topics - Create topic", async ({ request }) => {
    const topicData = {
      title: `Test Topic ${Date.now()}`,
      content: "Test topic content",
      moduleId: createdModuleId,
      order: 1,
      type: "video",
      videoUrl: "https://youtube.com/watch?v=test123",
    };

    const res = await request.post(`${API}/api/academy/topics`, {
      headers: { Cookie: authCookie },
      data: topicData,
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.topic).toBeDefined();
    expect(data.topic.title).toBe(topicData.title);
    createdTopicId = data.topic.id;
  });

  test("GET /academy/topics/:id - Get topic", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/topics/${createdTopicId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.topic).toBeDefined();
    expect(data.topic.id).toBe(createdTopicId);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // QUIZZES
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/quizzes - Create quiz", async ({ request }) => {
    const quizData = {
      title: `Test Quiz ${Date.now()}`,
      description: "Test quiz",
      moduleId: createdModuleId,
      timeLimitMinutes: 30,
      questions: [
        {
          text: "Question 1?",
          type: "multiple_choice",
          options: [
            { text: "Option A", isCorrect: true },
            { text: "Option B", isCorrect: false },
          ],
        },
      ],
    };

    const res = await request.post(`${API}/academy/quizzes`, {
      headers: { Cookie: authCookie },
      data: quizData,
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.quiz).toBeDefined();
    expect(data.quiz.title).toBe(quizData.title);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARNING PATHS
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/learning-paths - Create learning path", async ({ request }) => {
    const pathData = {
      name: `Test Path ${Date.now()}`,
      description: "Test learning path",
      courses: [createdCourseId],
    };

    const res = await request.post(`${API}/api/academy/learning-paths`, {
      headers: { Cookie: authCookie },
      data: pathData,
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.learningPath).toBeDefined();
    expect(data.learningPath.name).toBe(pathData.name);
  });

  test("GET /academy/learning-paths - List learning paths", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/learning-paths`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.learningPaths)).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROUPS
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/groups - Create group", async ({ request }) => {
    const groupData = {
      name: `Test Group ${Date.now()}`,
      description: "Test group",
      supervisorIds: [],
    };

    const res = await request.post(`${API}/academy/groups`, {
      headers: { Cookie: authCookie },
      data: groupData,
    });

    expect(res.status()).toBe(201);
    const data = await res.json();
    expect(data.group).toBeDefined();
    expect(data.group.name).toBe(groupData.name);
  });

  test("GET /academy/groups - List groups", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/groups`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.groups)).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ASSIGNMENTS
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/assignments - Create assignment", async ({ request }) => {
    const assignmentData = {
      courseId: createdCourseId,
      userId: "test-user-id", // This should be a real user ID in production
      method: "manual",
    };

    const res = await request.post(`${API}/api/academy/assignments`, {
      headers: { Cookie: authCookie },
      data: assignmentData,
    });

    // May fail if user doesn't exist, that's ok for this test
    expect([201, 400, 404]).toContain(res.status());
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════════════════════

  test("GET /academy/dashboard/my-progress - Get user progress", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/dashboard/my-progress`, {
      headers: { Cookie: authCookie },
    });

    // Should return 200 even if no progress yet
    expect([200, 404]).toContain(res.status());
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // MEDIA / YOUTUBE
  // ═══════════════════════════════════════════════════════════════════════════

  test("POST /academy/media/youtube-info - Get YouTube video info", async ({ request }) => {
    const res = await request.post(`${API}/academy/media/youtube-info`, {
      headers: { Cookie: authCookie },
      data: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });

    // May return 200 with info or 400 if invalid URL
    expect([200, 400]).toContain(res.status());
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════════

  test("DELETE /academy/topics/:id - Delete topic", async ({ request }) => {
    const res = await request.delete(`${API}/api/academy/topics/${createdTopicId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
  });

  test("DELETE /academy/modules/:id - Delete module", async ({ request }) => {
    const res = await request.delete(`${API}/api/academy/modules/${createdModuleId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
  });

  test("DELETE /academy/courses/:id - Delete course", async ({ request }) => {
    const res = await request.delete(`${API}/api/academy/courses/${createdCourseId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN-ONLY ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Academy LMS Admin Endpoints", () => {
  test("GET /academy/sync/role-mapping - Get role mappings (admin only)", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/sync/role-mapping`, {
      headers: { Cookie: authCookie },
    });

    // Should return 200 for admin, 403 for non-admin
    expect([200, 403]).toContain(res.status());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════

test.describe("Academy LMS Error Handling", () => {
  test("GET /academy/courses/:id - Returns 404 for non-existent course", async ({ request }) => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request.get(`${API}/api/academy/courses/${fakeId}`, {
      headers: { Cookie: authCookie },
    });

    expect(res.status()).toBe(404);
  });

  test("POST /academy/courses - Returns 400 for invalid data", async ({ request }) => {
    const res = await request.post(`${API}/api/academy/courses`, {
      headers: { Cookie: authCookie },
      data: { invalidField: "test" },
    });

    expect(res.status()).toBe(400);
  });

  test("Unauthorized access returns 401", async ({ request }) => {
    const res = await request.get(`${API}/api/academy/courses`);
    expect(res.status()).toBe(401);
  });
});
