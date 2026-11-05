/**
 * CRM Kon - Integration Tests
 *
 * End-to-end tests using Playwright to verify the CRM API works with a real database.
 *
 * `/api/crm` is behind the host's staff gate: a request without credentials is a 401, so these
 * requests authenticate as an agent with `Authorization: Bearer <token>`. Create an agent key
 * with the `crm:*` scope on a TEST installation (never production: the tests create and delete
 * records) and pass it in the environment, never in a file:
 *
 *   API_URL=http://localhost:3000 KITSUDEN_API_TOKEN=kitsuden_agent_... pnpm test:integration
 *
 * Without `KITSUDEN_API_TOKEN` every test is skipped, instead of reporting the 401 as a failure
 * of the CRM.
 */

import { test, expect } from "@playwright/test";

const API = (process.env.API_URL || "http://localhost:3000") + "/api/crm";
const TOKEN = process.env.KITSUDEN_API_TOKEN;
const NO_TOKEN = "set KITSUDEN_API_TOKEN to an agent key with crm:* on a test installation";

test.use({
  extraHTTPHeaders: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});

test.describe("CRM Kon - Credentials", () => {
  test.skip(!TOKEN, NO_TOKEN);

  test("the token is accepted, and a request without it is refused", async ({ playwright }) => {
    const anonymous = await playwright.request.newContext();
    const refused = await anonymous.get(`${API}/companies`);
    expect(refused.status()).toBe(401);
    await anonymous.dispose();
  });
});

// Test data generators
const generateTestCompany = () => ({
  name: `Test Company ${Date.now()}`,
  domain: "testcompany.com",
  industry: "Technology",
  size: "11-50",
  website: "https://testcompany.com",
  city: "San Francisco",
  country: "USA",
});

const generateTestContact = (companyId?: string) => ({
  firstName: "John",
  lastName: `Doe ${Date.now()}`,
  email: `john.doe.${Date.now()}@test.com`,
  phone: "+1-555-1234",
  jobTitle: "Software Engineer",
  status: "lead" as const,
  companyId,
});

const generateTestPipeline = () => ({
  name: `Sales Pipeline ${Date.now()}`,
  description: "Test pipeline for integration tests",
  currency: "USD",
});

const generateTestDeal = (pipelineId: string, stageId: string, contactId?: string) => ({
  title: `Big Deal ${Date.now()}`,
  description: "A very important deal",
  value: 50000,
  currency: "USD",
  pipelineId,
  stageId,
  contactId,
  expectedCloseDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
});

const generateTestActivity = (contactId?: string, dealId?: string) => ({
  type: "call" as const,
  subject: `Follow-up Call ${Date.now()}`,
  description: "Discuss contract terms",
  contactId,
  dealId,
  dueDate: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
});

test.describe("CRM Kon - Companies API", () => {
  test.skip(!TOKEN, NO_TOKEN);

  test("should create, read, update and delete a company", async ({ request }) => {
    // Create
    const createData = generateTestCompany();
    const createRes = await request.post(`${API}/companies`, { data: createData });
    expect(createRes.status()).toBe(201);

    const created = await createRes.json();
    expect(created.data).toBeDefined();
    expect(created.data.name).toBe(createData.name);
    expect(created.data.id).toBeDefined();
    const companyId = created.data.id;

    // Read
    const readRes = await request.get(`${API}/companies/${companyId}`);
    expect(readRes.status()).toBe(200);

    const read = await readRes.json();
    expect(read.data).toBeDefined();
    expect(read.data.name).toBe(createData.name);
    expect(read.data.stats).toBeDefined();

    // Update
    const updateRes = await request.patch(`${API}/companies/${companyId}`, {
      data: { name: "Updated Company Name" },
    });
    expect(updateRes.status()).toBe(200);

    const updated = await updateRes.json();
    expect(updated.data).toBeDefined();

    // Delete
    const deleteRes = await request.delete(`${API}/companies/${companyId}`);
    expect(deleteRes.status()).toBe(200);

    const deleted = await deleteRes.json();
    expect(deleted.data.deleted).toBe(true);

    // Verify deletion
    const notFoundRes = await request.get(`${API}/companies/${companyId}`);
    expect(notFoundRes.status()).toBe(404);
  });

  test("should list companies with pagination", async ({ request }) => {
    const listRes = await request.get(`${API}/companies?limit=10&offset=0`);
    expect(listRes.status()).toBe(200);

    const list = await listRes.json();
    expect(list.data).toBeDefined();
    expect(Array.isArray(list.data)).toBe(true);
    expect(list.pagination).toBeDefined();
  });

  test("should filter companies by industry", async ({ request }) => {
    const res = await request.get(`${API}/companies?industry=Technology`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);
  });
});

test.describe("CRM Kon - Contacts API", () => {
  test.skip(!TOKEN, NO_TOKEN);

  test("should create, read, update and delete a contact", async ({ request }) => {
    // Create
    const createData = generateTestContact();
    const createRes = await request.post(`${API}/contacts`, { data: createData });
    expect(createRes.status()).toBe(201);

    const created = await createRes.json();
    expect(created.data).toBeDefined();
    expect(created.data.firstName).toBe(createData.firstName);
    expect(created.data.email).toBe(createData.email);
    const contactId = created.data.id;

    // Read
    const readRes = await request.get(`${API}/contacts/${contactId}`);
    expect(readRes.status()).toBe(200);

    const read = await readRes.json();
    expect(read.data).toBeDefined();
    expect(read.data.firstName).toBe(createData.firstName);

    // Update
    const updateRes = await request.patch(`${API}/contacts/${contactId}`, {
      data: { firstName: "Jane", status: "prospect" },
    });
    expect(updateRes.status()).toBe(200);

    const updated = await updateRes.json();
    expect(updated.data).toBeDefined();

    // Delete
    const deleteRes = await request.delete(`${API}/contacts/${contactId}`);
    expect(deleteRes.status()).toBe(200);
  });

  test("should list contacts with filters", async ({ request }) => {
    const res = await request.get(`${API}/contacts?status=lead&limit=10`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("should search contacts by name", async ({ request }) => {
    const res = await request.get(`${API}/contacts?search=john&limit=10`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.data).toBeDefined();
  });
});

test.describe("CRM Kon - Pipelines API", () => {
  test.skip(!TOKEN, NO_TOKEN);

  test("should create pipeline with default stages", async ({ request }) => {
    const createData = generateTestPipeline();
    const createRes = await request.post(`${API}/pipelines`, { data: createData });
    expect(createRes.status()).toBe(201);

    const created = await createRes.json();
    expect(created.data).toBeDefined();
    expect(created.data.name).toBe(createData.name);
    const pipelineId = created.data.id;

    // Verify pipeline has stages
    const readRes = await request.get(`${API}/pipelines/${pipelineId}`);
    expect(readRes.status()).toBe(200);

    const read = await readRes.json();
    expect(read.data).toBeDefined();
    expect(Array.isArray(read.data.stages)).toBe(true);
    expect(read.data.stages.length).toBeGreaterThan(0);

    // Cleanup
    await request.delete(`${API}/pipelines/${pipelineId}`);
  });

  test("should manage pipeline stages", async ({ request }) => {
    // Create pipeline
    const pipelineRes = await request.post(`${API}/pipelines`, {
      data: { ...generateTestPipeline(), createDefaultStages: false },
    });
    expect(pipelineRes.status()).toBe(201);
    const pipelineId = (await pipelineRes.json()).data.id;

    // Add stage
    const stageRes = await request.post(`${API}/pipelines/${pipelineId}/stages`, {
      data: { name: "New Stage", color: "#ff0000", order: 0, probability: 50 },
    });
    expect(stageRes.status()).toBe(201);

    const stage = await stageRes.json();
    expect(stage.data).toBeDefined();
    const stageId = stage.data.id;

    // Update stage
    const updateRes = await request.patch(`${API}/stages/${stageId}`, {
      data: { name: "Updated Stage", probability: 75 },
    });
    expect(updateRes.status()).toBe(200);

    // Cleanup
    await request.delete(`${API}/stages/${stageId}`);
    await request.delete(`${API}/pipelines/${pipelineId}`);
  });
});

test.describe("CRM Kon - Deals API", () => {
  test.skip(!TOKEN, NO_TOKEN);

  let pipelineId: string;
  let stageId: string;

  test.beforeEach(async ({ request }) => {
    // Create a pipeline with stages for deal tests
    const pipelineRes = await request.post(`${API}/pipelines`, {
      data: { name: `Deal Test Pipeline ${Date.now()}` },
    });
    expect(pipelineRes.status()).toBe(201);
    const pipeline = await pipelineRes.json();
    pipelineId = pipeline.data.id;

    // Get first stage
    const stagesRes = await request.get(`${API}/pipelines/${pipelineId}`);
    const stages = await stagesRes.json();
    stageId = stages.data.stages[0].id;
  });

  test.afterEach(async ({ request }) => {
    // Cleanup pipeline
    if (pipelineId) {
      await request.delete(`${API}/pipelines/${pipelineId}`);
    }
  });

  test("should create, read, update and delete a deal", async ({ request }) => {
    const createData = generateTestDeal(pipelineId, stageId);
    const createRes = await request.post(`${API}/deals`, { data: createData });
    expect(createRes.status()).toBe(201);

    const created = await createRes.json();
    expect(created.data).toBeDefined();
    expect(created.data.title).toBe(createData.title);
    expect(created.data.value).toBe(createData.value);
    const dealId = created.data.id;

    // Read
    const readRes = await request.get(`${API}/deals/${dealId}`);
    expect(readRes.status()).toBe(200);

    const read = await readRes.json();
    expect(read.data).toBeDefined();
    expect(read.data.title).toBe(createData.title);

    // Update
    const updateRes = await request.patch(`${API}/deals/${dealId}`, {
      data: { title: "Updated Deal Title", value: 75000 },
    });
    expect(updateRes.status()).toBe(200);

    // Delete
    const deleteRes = await request.delete(`${API}/deals/${dealId}`);
    expect(deleteRes.status()).toBe(200);
  });

  test("should move deal between stages", async ({ request }) => {
    // Create deal
    const dealRes = await request.post(`${API}/deals`, {
      data: generateTestDeal(pipelineId, stageId),
    });
    const dealId = (await dealRes.json()).data.id;

    // Get second stage
    const stagesRes = await request.get(`${API}/pipelines/${pipelineId}`);
    const stages = (await stagesRes.json()).data.stages;

    if (stages.length > 1) {
      const secondStageId = stages[1].id;

      // Move deal
      const moveRes = await request.post(`${API}/deals/${dealId}/move`, {
        data: { targetStageId: secondStageId, newOrder: 0 },
      });
      expect(moveRes.status()).toBe(200);

      const moved = await moveRes.json();
      expect(moved.data).toBeDefined();
    }

    // Cleanup
    await request.delete(`${API}/deals/${dealId}`);
  });

  test("should get kanban board data", async ({ request }) => {
    const kanbanRes = await request.get(`${API}/pipelines/${pipelineId}/kanban`);
    expect(kanbanRes.status()).toBe(200);

    const kanban = await kanbanRes.json();
    expect(kanban.data).toBeDefined();
    expect(kanban.data.pipeline).toBeDefined();
    expect(Array.isArray(kanban.data.stages)).toBe(true);
    expect(kanban.data.stages[0].deals).toBeDefined();
  });
});

test.describe("CRM Kon - Activities API", () => {
  test.skip(!TOKEN, NO_TOKEN);

  test("should create, read, complete and delete an activity", async ({ request }) => {
    // Create
    const createData = generateTestActivity();
    const createRes = await request.post(`${API}/activities`, { data: createData });
    expect(createRes.status()).toBe(201);

    const created = await createRes.json();
    expect(created.data).toBeDefined();
    expect(created.data.subject).toBe(createData.subject);
    const activityId = created.data.id;

    // Read
    const readRes = await request.get(`${API}/activities/${activityId}`);
    expect(readRes.status()).toBe(200);

    // Complete
    const completeRes = await request.post(`${API}/activities/${activityId}/complete`, {
      data: { outcome: "successful", notes: "Call went well" },
    });
    expect(completeRes.status()).toBe(200);

    const completed = await completeRes.json();
    expect(completed.data).toBeDefined();
    expect(completed.data.completedAt).toBeDefined();

    // Delete
    const deleteRes = await request.delete(`${API}/activities/${activityId}`);
    expect(deleteRes.status()).toBe(200);
  });

  test("should list activities with filters", async ({ request }) => {
    const res = await request.get(`${API}/activities?type=call&completed=false&limit=10`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(Array.isArray(data.data)).toBe(true);
  });
});

test.describe("CRM Kon - Dashboard Stats", () => {
  test.skip(!TOKEN, NO_TOKEN);

  test("should return CRM statistics", async ({ request }) => {
    const res = await request.get(`${API}/stats`);
    expect(res.status()).toBe(200);

    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(data.data).toBeDefined();

    // Verify stats structure
    expect(typeof data.data.contacts).toBe("number");
    expect(typeof data.data.companies).toBe("number");
    expect(data.data.deals).toBeDefined();
    expect(typeof data.data.deals.total).toBe("number");
    expect(typeof data.data.deals.open).toBe("number");
    expect(typeof data.data.deals.won).toBe("number");
    expect(typeof data.data.deals.lost).toBe("number");
    expect(data.data.activities).toBeDefined();
  });
});
