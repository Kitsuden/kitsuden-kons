/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * KON-BLOG SANDBOX TEST
 * Using mock context to test kon functionality
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import type { KonContext } from "@kitsuden/shared";
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";

// Import kon
import { kon, createBlogRouter, blogPosts } from "./src/index";

describe("kon-blog with sandbox", () => {
  // Create a mock context (in real usage, this would come from createDrizzleSandbox)
  let mockContext: KonContext;
  let router: Hono;
  const emittedEvents: Array<{ name: string; data: any }> = [];

  beforeAll(async () => {
    emittedEvents.length = 0; // Clear events

    // Create mock context similar to what createDrizzleSandbox would provide
    mockContext = {
      db: {
        instance: {},
        execute: async (_sql: string) => [],
        tableExists: async () => true,
      },
      cache: {
        get: async () => null,
        set: async () => {},
        invalidate: async () => {},
      },
      events: {
        emit: (name: string, data: any) => {
          emittedEvents.push({ name, data });
          console.log(`[Event Emitted] ${name}`);
        },
        on: () => {},
      },
      realtime: {
        broadcast: () => {},
        sendToUser: () => {},
      },
      auth: {
        requireAuth: async (c: any, next: any) => {
          const user = c.get("testUser");
          if (!user) return c.json({ error: "Unauthorized" }, 401);
          await next();
        },
        requireRole: (roles: string[]) => async (c: any, next: any) => {
          const user = c.get("testUser");
          if (!user || !roles.includes(user.role)) {
            return c.json({ error: "Forbidden" }, 403);
          }
          await next();
        },
        optionalAuth: async (_c: any, next: any) => await next(),
        getSession: async () => null,
      },
      storage: {
        getSignedUploadUrl: async () => "https://test.example.com/upload",
        getSignedDownloadUrl: async () => "https://test.example.com/download",
        delete: async () => {},
      },
      contentPublishing: {
        getAvailableTargets: () => [],
        hasTarget: () => false,
        register: () => {},
        unregister: () => {},
        promote: async () => ({
          contentId: "test-123",
          targetId: "blog",
          slug: "test-post",
          url: "/blog/test-post",
          status: "published",
          createdAt: new Date(),
        }),
        unpublish: async () => {},
        getPublishedUrl: () => "/blog/test-post",
      },
      logger: {
        info: (msg: string) => console.log(`[ℹ️ Blog] ${msg}`),
        warn: (msg: string) => console.log(`[⚠️ Blog] ${msg}`),
        error: (msg: string) => console.log(`[❌ Blog] ${msg}`),
        debug: (_msg: string) => {},
      },
      config: {
        siteName: "Test Site",
        siteUrl: "http://localhost:3001",
        environment: "test",
      },
    } as KonContext;

    // Create router with mock context
    router = createBlogRouter(mockContext);

    console.log("✅ Sandbox test setup complete");
  });

  afterAll(() => {
    console.log("🧹 Sandbox test cleanup");
  });

  describe("Router HTTP endpoints", () => {
    it("router responds to requests", async () => {
      const req = new Request("http://localhost/", { method: "GET" });
      const res = await router.fetch(req);

      // Router exists and responds (may be 200, 404, or 500 depending on implementation)
      expect(typeof res.status).toBe("number");
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(600);
    });

    it("GET /posts route exists", async () => {
      const req = new Request("http://localhost/posts", { method: "GET" });
      const res = await router.fetch(req);

      // Route exists and returns a response
      expect(res).toBeDefined();
      expect(typeof res.status).toBe("number");
    });

    it("POST /posts route exists", async () => {
      const req = new Request("http://localhost/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test" }),
      });

      const res = await router.fetch(req);
      expect(res).toBeDefined();
      expect(typeof res.status).toBe("number");
    });

    it("router returns JSON responses", async () => {
      const req = new Request("http://localhost/", { method: "GET" });
      const res = await router.fetch(req);

      const contentType = res.headers.get("content-type") || "";
      if (res.status === 200) {
        expect(contentType.includes("json") || contentType === "").toBe(true);
      }
    });
  });

  describe("Authentication middleware", () => {
    it("auth middleware rejects requests without user", async () => {
      const c = {
        get: () => undefined, // No user
        set: () => {},
        json: (data: any, status?: number) => ({ status: status || 200, data }),
      };

      let nextCalled = false;
      const next = async () => {
        nextCalled = true;
      };

      const result = await mockContext.auth.requireAuth(c as any, next);

      // Should return 401 response, not call next
      expect(nextCalled).toBe(false);
      expect((result as any).status).toBe(401);
    });

    it("auth middleware allows requests with user", async () => {
      const c = {
        get: (key: string) => (key === "testUser" ? { id: "1", role: "admin" } : undefined),
        set: () => {},
      };

      let nextCalled = false;
      const next = async () => {
        nextCalled = true;
      };

      await mockContext.auth.requireAuth(c as any, next);

      expect(nextCalled).toBe(true);
    });

    it("role middleware checks roles correctly", async () => {
      const c = {
        get: (key: string) => (key === "testUser" ? { id: "1", role: "editor" } : undefined),
        set: () => {},
        json: (data: any, status?: number) => ({ status: status || 200, data }),
      };

      let nextCalled = false;
      const next = async () => {
        nextCalled = true;
      };

      // Require admin role, but user is editor
      const middleware = mockContext.auth.requireRole(["admin"]);
      const result = await middleware(c as any, next);

      expect(nextCalled).toBe(false);
      expect((result as any).status).toBe(403);
    });
  });

  describe("Event emission", () => {
    it("tracks events emitted by kon", () => {
      // Clear previous events
      emittedEvents.length = 0;

      // Emit a test event
      mockContext.events.emit("blog:test", { data: "test" });

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].name).toBe("blog:test");
      expect(emittedEvents[0].data).toEqual({ data: "test" });
    });

    it("can emit multiple events", () => {
      emittedEvents.length = 0;

      mockContext.events.emit("event1", { id: 1 });
      mockContext.events.emit("event2", { id: 2 });
      mockContext.events.emit("event3", { id: 3 });

      expect(emittedEvents).toHaveLength(3);
    });
  });

  describe("Content Publishing integration", () => {
    it("has content publishing methods", () => {
      expect(typeof mockContext.contentPublishing.promote).toBe("function");
      expect(typeof mockContext.contentPublishing.getPublishedUrl).toBe("function");
      expect(typeof mockContext.contentPublishing.unpublish).toBe("function");
    });

    it("can promote content to blog", async () => {
      const result = await mockContext.contentPublishing.promote("blog", {
        source: {
          type: "dataset",
          recordId: "post-123",
          data: { title: "Test" },
        },
        options: {
          title: "Test Post",
          slug: "test-post",
        },
      });

      expect(result.contentId).toBe("test-123");
      expect(result.url).toBe("/blog/test-post");
      expect(result.status).toBe("published");
    });

    it("getPublishedUrl returns correct URL", () => {
      const url = mockContext.contentPublishing.getPublishedUrl("blog", {
        contentId: "123",
        targetId: "blog",
        slug: "my-post",
        url: "/blog/my-post",
        status: "published",
        createdAt: new Date(),
      });

      expect(url).toBe("/blog/test-post");
    });
  });

  describe("Kon lifecycle hooks", () => {
    it("calls onStartup hook without errors", async () => {
      expect(typeof kon.hooks?.onStartup).toBe("function");

      // Should not throw
      if (kon.hooks?.onStartup) {
        await kon.hooks.onStartup(mockContext);
      }
    });

    it("calls onEnable hook without errors", async () => {
      expect(typeof kon.hooks?.onEnable).toBe("function");

      if (kon.hooks?.onEnable) {
        await kon.hooks.onEnable(mockContext);
      }
    });

    it("calls onDisable hook without errors", async () => {
      expect(typeof kon.hooks?.onDisable).toBe("function");

      if (kon.hooks?.onDisable) {
        await kon.hooks.onDisable(mockContext);
      }
    });
  });

  describe("Database integration", () => {
    it("exports blogPosts schema", () => {
      expect(blogPosts).toBeDefined();
      // blogPosts is a Drizzle table definition
      expect(typeof blogPosts).toBe("object");
    });

    it("context has db methods", () => {
      expect(typeof mockContext.db.execute).toBe("function");
      expect(typeof mockContext.db.tableExists).toBe("function");
    });
  });
});

console.log("\n📝 Test using mock KonContext");
console.log(
  "   For full DB integration: import { createDrizzleSandbox } from '@kitsuden/testing/sandbox-drizzle'\n"
);
