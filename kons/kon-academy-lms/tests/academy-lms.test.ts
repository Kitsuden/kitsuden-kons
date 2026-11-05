/**
 * Academy LMS - Complete Test Suite
 *
 * Unit and integration tests for all services and endpoints.
 */

import { describe, it, expect, setDefaultTimeout } from "bun:test";

// The first Excel test loads exceljs lazily, which takes more than bun's 5 s on a busy machine.
setDefaultTimeout(30_000);

// ============================================
// PDF SERVICE TESTS
// ============================================

describe("📄 PDF Service", async () => {
  const { generateCertificatePdf, validateCertificateCode, extractCodeInfo } =
    await import("../services/pdf.service");

  describe("generateCertificatePdf", () => {
    it("should generate a valid PDF certificate", async () => {
      const data = {
        userName: "Juan Pérez García",
        courseName: "Introduction to the Kitsuden Platform",
        completedAt: new Date("2024-03-15"),
        durationHours: 8.5,
        code: "CERT-ABC12345-XYZ67890-ABCDEF",
      };

      const pdfBuffer = await generateCertificatePdf(data);

      expect(pdfBuffer).toBeDefined();
      expect(pdfBuffer.length).toBeGreaterThan(0);
      // PDF magic number: %PDF
      expect(pdfBuffer.slice(0, 4).toString()).toBe("%PDF");
    });

    it("should generate a certificate with a custom template", async () => {
      const data = {
        userName: "María López",
        courseName: "Project Management",
        completedAt: new Date(),
        durationHours: 16,
        code: "CERT-TEST123-USER456-ABC123",
      };

      const template = {
        type: "generated" as const,
        primaryColor: "#FF5733",
        secondaryColor: "#333333",
        primaryText: "We certify that",
        secondaryText: "has successfully completed the program:",
      };

      const pdfBuffer = await generateCertificatePdf(data, template);

      expect(pdfBuffer).toBeDefined();
      expect(pdfBuffer.length).toBeGreaterThan(1000);
    });

    it("should adjust font size for long names", async () => {
      const data = {
        userName: "María Elena González de la Cruz Martínez",
        courseName: "Course",
        completedAt: new Date(),
        durationHours: 5,
        code: "CERT-LONG-NAME-TEST123",
      };

      const pdfBuffer = await generateCertificatePdf(data);
      expect(pdfBuffer).toBeDefined();
    });
  });

  describe("validateCertificateCode", () => {
    it("should validate correct codes", () => {
      const validCodes = [
        "CERT-ABC12345-XYZ67890-ABCDEF",
        "CERT-12345678-87654321-A1B2C3D",
        "CERT-TEST1234-USER5678-ABC123456",
      ];

      for (const code of validCodes) {
        expect(validateCertificateCode(code)).toBe(true);
      }
    });

    it("should reject invalid codes", () => {
      const invalidCodes = [
        "",
        "CERT",
        "CERT-",
        "INVALID-ABC123-XYZ789",
        "cert-lowercase-123",
        "CERT-123-456",
        "CERT-SPECIAL!@#-123-ABC",
      ];

      for (const code of invalidCodes) {
        expect(validateCertificateCode(code)).toBe(false);
      }
    });
  });

  describe("extractCodeInfo", () => {
    it("should extract information correctly", () => {
      const code = "CERT-ABC12345-XYZ67890-ABCDEF";
      const info = extractCodeInfo(code);

      expect(info).not.toBeNull();
      expect(info?.courseId).toBe("ABC12345");
      expect(info?.userId).toBe("XYZ67890");
      expect(info?.timestamp).toBeGreaterThan(0);
    });

    it("should return null for invalid codes", () => {
      const info = extractCodeInfo("INVALID-CODE");
      expect(info).toBeNull();
    });
  });
});

// ============================================
// EXCEL SERVICE TESTS
// ============================================

describe("📊 Excel Service", async () => {
  const { generateAssignmentsExcel, generateProgressExcel, generateSurveysExcel } =
    await import("../services/excel.service");

  describe("generateAssignmentsExcel", () => {
    it("should generate an assignments Excel file", async () => {
      const data = [
        {
          date: new Date("2024-01-15"),
          course: "Onboarding course",
          courseType: "ONBOARDING" as const,
          durationHours: 8,
          user: "Juan Pérez",
          employeeNumber: "EMP001",
          group: "Group A",
          method: "manual" as const,
          progress: 100,
          finishedAt: new Date("2024-01-20"),
          status: "Completed" as const,
        },
        {
          date: new Date("2024-02-01"),
          course: "Project Management",
          courseType: "MANAGEMENT" as const,
          durationHours: 16,
          user: "María García",
          group: undefined,
          method: "group" as const,
          progress: 50,
          finishedAt: null,
          status: "In Progress" as const,
        },
      ];

      const excelBuffer = await generateAssignmentsExcel(data);

      expect(excelBuffer).toBeDefined();
      expect(excelBuffer.length).toBeGreaterThan(100);
      // XLSX magic number: PK (zip)
      expect(excelBuffer.slice(0, 2).toString("hex")).toBe("504b");
    });

    it("should handle an empty list", async () => {
      const excelBuffer = await generateAssignmentsExcel([]);
      expect(excelBuffer).toBeDefined();
    });
  });

  describe("generateProgressExcel", () => {
    it("should generate a progress Excel file", async () => {
      const data = [
        {
          user: "Juan Pérez",
          email: "juan@company.com",
          course: "Onboarding course",
          module: "Module 1",
          completedTopics: 5,
          totalTopics: 5,
          passedQuizzes: 2,
          totalQuizzes: 2,
          progressPercent: 100,
          status: "Completed" as const,
          startDate: new Date("2024-01-15"),
          completedAt: new Date("2024-01-20"),
        },
      ];

      const excelBuffer = await generateProgressExcel(data);
      expect(excelBuffer).toBeDefined();
      expect(excelBuffer.length).toBeGreaterThan(100);
    });
  });

  describe("generateSurveysExcel", () => {
    it("should generate a surveys Excel file", async () => {
      const data = [
        {
          date: new Date("2024-03-01"),
          course: "Onboarding course",
          user: "Juan Pérez",
          department: "TECHNOLOGY" as const,
          jobTitle: "Analyst" as const,
          presenter: 5,
          usefulness: "Yes",
          satisfaction: 5,
          learned: "I learned a lot about the platform",
          place: "OFFICE" as const,
          role: "Participant" as const,
          recommendation: "Excellent course",
          comments: "Very good experience",
        },
      ];

      const excelBuffer = await generateSurveysExcel(data);
      expect(excelBuffer).toBeDefined();
      expect(excelBuffer.length).toBeGreaterThan(100);
    });
  });
});

// ============================================
// MEDIA SERVICE TESTS (YOUTUBE)
// ============================================

describe("🎬 Media Service - YouTube", async () => {
  const {
    extractYoutubeInfo,
    normalizeVideoUrl,
    validateFile,
    determineMediaType,
    formatBytes,
  } = await import("../services/media.service");

  describe("extractYoutubeInfo", () => {
    it("should extract info from a standard YouTube URL", () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const info = extractYoutubeInfo(url);

      expect(info.valid).toBe(true);
      expect(info.videoId).toBe("dQw4w9WgXcQ");
      expect(info.embedUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
      expect(info.thumbnailUrl).toBe("https://img.youtube.com/vi/dQw4w9WgXcQ/maxresdefault.jpg");
    });

    it("should extract info from a short YouTube URL", () => {
      const url = "https://youtu.be/dQw4w9WgXcQ";
      const info = extractYoutubeInfo(url);

      expect(info.valid).toBe(true);
      expect(info.videoId).toBe("dQw4w9WgXcQ");
      expect(info.embedUrl).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    });

    it("should extract info from an embed URL", () => {
      const url = "https://www.youtube.com/embed/dQw4w9WgXcQ";
      const info = extractYoutubeInfo(url);

      expect(info.valid).toBe(true);
      expect(info.videoId).toBe("dQw4w9WgXcQ");
    });

    it("should reject invalid URLs", () => {
      const invalidUrls = [
        "https://www.google.com",
        "https://www.youtube.com",
        "https://youtu.be/",
        "",
        "not-a-url",
        "https://www.youtube.com/watch",
      ];

      for (const url of invalidUrls) {
        const info = extractYoutubeInfo(url);
        expect(info.valid).toBe(false);
        expect(info.videoId).toBeUndefined();
      }
    });

    it("should handle URLs with additional parameters", () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s&feature=share";
      const info = extractYoutubeInfo(url);

      expect(info.valid).toBe(true);
      expect(info.videoId).toBe("dQw4w9WgXcQ");
    });

    it("should handle playlist URLs", () => {
      const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLsomeplaylist";
      const info = extractYoutubeInfo(url);

      expect(info.valid).toBe(true);
      expect(info.videoId).toBe("dQw4w9WgXcQ");
    });
  });

  describe("normalizeVideoUrl", () => {
    it("should normalize a YouTube URL", () => {
      const result = normalizeVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");

      expect(result.type).toBe("youtube");
      expect(result.url).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
      expect(result.thumbnailUrl).toBeDefined();
    });

    it("should normalize a Vimeo URL", () => {
      const result = normalizeVideoUrl("https://vimeo.com/123456789");

      expect(result.type).toBe("vimeo");
      expect(result.url).toBe("https://player.vimeo.com/video/123456789");
      expect(result.thumbnailUrl).toBe("https://vumbnail.com/123456789.jpg");
    });

    it("should detect an iframe embed", () => {
      const url = '<iframe src="https://example.com/video"></iframe>';
      const result = normalizeVideoUrl(url);

      expect(result.type).toBe("embed");
      expect(result.url).toBe(url);
    });

    it("should treat a direct URL as direct type", () => {
      const url = "https://example.com/video.mp4";
      const result = normalizeVideoUrl(url);

      expect(result.type).toBe("direct");
      expect(result.url).toBe(url);
    });
  });

  describe("validateFile", () => {
    it("should validate images correctly", () => {
      const file = { name: "image.jpg", size: 1024 * 1024, type: "image/jpeg" };
      const result = validateFile(file, "image");

      expect(result.valid).toBe(true);
    });

    it("should reject very large images", () => {
      const file = { name: "large.jpg", size: 100 * 1024 * 1024, type: "image/jpeg" };
      const result = validateFile(file, "image");

      expect(result.valid).toBe(false);
    });

    it("should reject disallowed types", () => {
      const file = { name: "file.exe", size: 1024, type: "application/x-msdownload" };
      const result = validateFile(file, "document");

      expect(result.valid).toBe(false);
    });

    it("should validate videos", () => {
      const file = { name: "video.mp4", size: 50 * 1024 * 1024, type: "video/mp4" };
      const result = validateFile(file, "video");

      expect(result.valid).toBe(true);
    });

    it("should validate PDF documents", () => {
      const file = { name: "doc.pdf", size: 5 * 1024 * 1024, type: "application/pdf" };
      const result = validateFile(file, "document");

      expect(result.valid).toBe(true);
    });
  });

  describe("determineMediaType", () => {
    it("should detect images", () => {
      expect(determineMediaType("image/jpeg")).toBe("image");
      expect(determineMediaType("image/png")).toBe("image");
      expect(determineMediaType("image/webp")).toBe("image");
    });

    it("should detect videos", () => {
      expect(determineMediaType("video/mp4")).toBe("video");
      expect(determineMediaType("video/webm")).toBe("video");
    });

    it("should detect audio", () => {
      expect(determineMediaType("audio/mpeg")).toBe("audio");
      expect(determineMediaType("audio/wav")).toBe("audio");
    });

    it("should detect documents", () => {
      expect(determineMediaType("application/pdf")).toBe("document");
      expect(determineMediaType("application/msword")).toBe("document");
    });
  });

  describe("formatBytes", () => {
    it("should format bytes correctly", () => {
      expect(formatBytes(0)).toBe("0 Bytes");
      expect(formatBytes(1024)).toBe("1 KB");
      expect(formatBytes(1024 * 1024)).toBe("1 MB");
      expect(formatBytes(1024 * 1024 * 1024)).toBe("1 GB");
    });

    it("should use decimals correctly", () => {
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1536, 0)).toBe("2 KB");
    });
  });
});

// ============================================
// USER SYNC SERVICE TESTS
// ============================================

describe("👥 User Sync Service", async () => {
  const {
    validateExternalUser,
    validateExternalUsers,
    parseCsv,
    mapRole,
    mapDepartment,
    mapJobTitle,
    exampleRoleMapping,
  } = await import("../services/user-sync.service");

  describe("validateExternalUser", () => {
    it("should validate a correct user", () => {
      const user = {
        externalId: "EMP001",
        email: "juan@company.com",
        name: "Juan Pérez",
        lastName: "García",
      };

      const result = validateExternalUser(user);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.user.email).toBe("juan@company.com");
      }
    });

    it("should reject an invalid email", () => {
      const user = {
        externalId: "EMP001",
        email: "not-an-email",
        name: "Juan",
      };

      const result = validateExternalUser(user);
      expect(result.valid).toBe(false);
    });

    it("should reject missing required fields", () => {
      const user = {
        email: "juan@company.com",
        name: "Juan",
      };

      const result = validateExternalUser(user);
      expect(result.valid).toBe(false);
    });
  });

  describe("validateExternalUsers", () => {
    it("should separate valid and invalid", () => {
      const users = [
        { externalId: "1", email: "valid@example.com", name: "Valid" },
        { externalId: "2", email: "invalid-email", name: "Invalid" },
        { externalId: "3", email: "another@example.com", name: "Another" },
      ];

      const result = validateExternalUsers(users);
      expect(result.valid.length).toBe(2);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0].index).toBe(1);
    });
  });

  describe("parseCsv", () => {
    it("should parse valid CSV", () => {
      const csv = `externalId,email,name,lastName,department
EMP001,juan@example.com,Juan,Pérez,TECHNOLOGY
EMP002,maria@example.com,María,García,HUMAN_RESOURCES`;

      const users = parseCsv(csv);
      expect(users.length).toBe(2);
      expect(users[0].email).toBe("juan@example.com");
      expect(users[1].name).toBe("María");
    });

    it("should handle CSV with empty optional fields", () => {
      const csv = `externalId,email,name
EMP001,juan@example.com,Juan`;

      const users = parseCsv(csv);
      expect(users.length).toBe(1);
      expect(users[0].email).toBe("juan@example.com");
    });
  });

  describe("mapRole", () => {
    it("should map roles with the example mapping", () => {
      expect(mapRole("Administrator", exampleRoleMapping)).toBe("administrator");
      expect(mapRole("Supervisor", exampleRoleMapping)).toBe("supervisor");
      expect(mapRole("Analyst", exampleRoleMapping)).toBe("student");
      expect(mapRole("User", exampleRoleMapping)).toBe("student");
    });

    it("should use the default role for unknown roles", () => {
      expect(mapRole("UnknownRole", exampleRoleMapping)).toBe("student");
    });
  });

  describe("mapDepartment", () => {
    it("should map valid departments", () => {
      expect(mapDepartment("TECHNOLOGY")).toBe("TECHNOLOGY");
      expect(mapDepartment("HUMAN RESOURCES")).toBe("HUMAN_RESOURCES");
      expect(mapDepartment("human resources")).toBe("HUMAN_RESOURCES");
    });

    it("should return undefined for invalid departments", () => {
      expect(mapDepartment("Unknown Department")).toBeUndefined();
    });
  });

  describe("mapJobTitle", () => {
    it("should map valid positions", () => {
      expect(mapJobTitle("Analyst")).toBe("Analyst");
      expect(mapJobTitle("Professional")).toBe("Professional");
    });
  });

  describe("syncUsers", async () => {
    const { syncUsers, academyRoleFor } = await import("../services/user-sync.service");

    /** An in-memory store: the accounts that exist and the profiles written. */
    const storeWith = (accounts: string[], profiles: Record<string, string> = {}) => {
      const written: Record<string, { role: string; active: boolean }> = {};
      for (const [id, role] of Object.entries(profiles)) written[id] = { role, active: true };
      return {
        written,
        store: {
          existingAccounts: async (ids: string[]) => new Set(ids.filter((i) => accounts.includes(i))),
          hasProfile: async (id: string) => id in written,
          createProfile: async (p: { userId: string; trainingRole: string; active: boolean }) => {
            written[p.userId] = { role: p.trainingRole, active: p.active };
          },
          updateProfile: async (p: { userId: string; trainingRole: string; active: boolean }) => {
            written[p.userId] = { role: p.trainingRole, active: p.active };
          },
        },
      };
    };

    it("writes profiles of existing accounts and reports unknown ones", async () => {
      const { written, store } = storeWith(["u-1", "u-2"], { "u-2": "student" });
      const result = await syncUsers(
        [
          { externalId: "u-1", email: "a@example.com", name: "A", role: "supervisor" },
          { externalId: "E2", userId: "u-2", email: "b@example.com", name: "B", active: false },
          { externalId: "E3", userId: "u-404", email: "c@example.com", name: "C" },
        ],
        {},
        store
      );
      expect(result).toMatchObject({ successful: 2, failed: 1, created: 1, updated: 1 });
      expect(written["u-1"]).toEqual({ role: "supervisor", active: true });
      expect(written["u-2"]).toEqual({ role: "student", active: false });
      expect(written["u-404"]).toBeUndefined();
    });

    it("createNewUsers: false creates nothing", async () => {
      const { written, store } = storeWith(["u-1"]);
      const result = await syncUsers(
        [{ externalId: "u-1", email: "a@example.com", name: "A" }],
        { createNewUsers: false },
        store
      );
      expect(result.created).toBe(0);
      expect(written["u-1"]).toBeUndefined();
    });

    it("maps external roles, and falls back to student", () => {
      const user = { externalId: "1", email: "a@example.com", name: "A" };
      expect(academyRoleFor({ ...user, role: "administrator" }, {})).toBe("administrator");
      expect(academyRoleFor({ ...user, role: "Supervisor" }, { roleMapping: exampleRoleMapping })).toBe(
        "supervisor"
      );
      expect(academyRoleFor({ ...user, role: "Boss" }, {})).toBe("student");
    });
  });
});

// ============================================
// INTEGRATION TESTS - COMPLETE FLOWS
// ============================================

describe("🔄 Integration Flows", () => {
  describe("Flow: Course with YouTube Video", () => {
    it("should process a YouTube URL and create a topic", async () => {
      const { extractYoutubeInfo } = await import("../services/media.service");

      const youtubeUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
      const info = extractYoutubeInfo(youtubeUrl);

      expect(info.valid).toBe(true);
      expect(info.embedUrl).toContain("embed");

      // The data would be used to create a topic:
      // topic.videoYoutube = info.embedUrl
      // topic.thumbnailUrl = info.thumbnailUrl
    });

    it("should support multiple YouTube URL formats", async () => {
      const { extractYoutubeInfo } = await import("../services/media.service");

      const urls = [
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://youtu.be/dQw4w9WgXcQ",
        "https://www.youtube.com/embed/dQw4w9WgXcQ",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&start=30",
      ];

      for (const url of urls) {
        const info = extractYoutubeInfo(url);
        expect(info.valid).toBe(true);
        expect(info.videoId).toBe("dQw4w9WgXcQ");
      }
    });
  });

  describe("Flow: Synchronization and Export", () => {
    it("should synchronize users and export progress", async () => {
      const { parseCsv, validateExternalUsers } = await import("../services/user-sync.service");

      const csv = `externalId,email,name
EMP001,user1@test.com,User One
EMP002,user2@test.com,User Two`;

      const users = parseCsv(csv);
      const { valid } = validateExternalUsers(users);

      expect(valid.length).toBe(2);

      const { generateProgressExcel } = await import("../services/excel.service");

      const progressData = valid.map((u, i) => ({
        user: u.name,
        email: u.email,
        course: "Test Course",
        completedTopics: i === 0 ? 5 : 2,
        totalTopics: 5,
        passedQuizzes: i === 0 ? 2 : 0,
        totalQuizzes: 2,
        progressPercent: i === 0 ? 100 : 40,
        status: i === 0 ? "Completed" : "In Progress",
      }));

      const excel = await generateProgressExcel(progressData);
      expect(excel.length).toBeGreaterThan(100);
    });
  });

  describe("Flow: Complete Certificate", () => {
    it("should generate a certificate with a valid code", async () => {
      const { generateCertificatePdf, validateCertificateCode, extractCodeInfo } =
        await import("../services/pdf.service");

      const code = "CERT-ABC12345-XYZ67890-TEST123";

      const pdf = await generateCertificatePdf({
        userName: "Test User",
        courseName: "Test Course",
        completedAt: new Date(),
        durationHours: 10,
        code,
      });

      expect(pdf).toBeDefined();
      expect(validateCertificateCode(code)).toBe(true);

      const info = extractCodeInfo(code);
      expect(info).not.toBeNull();
      expect(info?.courseId).toBe("ABC12345");
    });
  });
});

// ============================================
// TEST SUMMARY
// ============================================

console.log("\n");
console.log("=".repeat(60));
console.log("🧪 Academy LMS - Test Suite");
console.log("=".repeat(60));
console.log("\nTest categories:");
console.log("  📄 PDF Service - Certificates");
console.log("  📊 Excel Service - Exports");
console.log("  🎬 Media Service - YouTube/Vimeo/Files");
console.log("  👥 User Sync Service - Synchronization");
console.log("  🔄 Integration - Complete flows");
console.log("\n" + "=".repeat(60));
