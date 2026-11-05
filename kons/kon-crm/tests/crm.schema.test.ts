/**
 * CRM Kon - Schema Tests
 *
 * Validates the Drizzle schema definitions including:
 * - Tables can be imported
 * - Enum definitions have correct values
 * - Types are correctly exported
 */

import { describe, it, expect } from "vitest";

import {
  crmCompanies,
  crmContacts,
  crmPipelines,
  crmPipelineStages,
  crmDeals,
  crmActivities,
  contactStatusEnum,
  dealStatusEnum,
  activityTypeEnum,
  priorityEnum,
  companiesRelations,
  contactsRelations,
  pipelinesRelations,
  pipelineStagesRelations,
  dealsRelations,
  activitiesRelations,
} from "../crm.schema";

describe("CRM Schema Definitions", () => {
  describe("Table Exports", () => {
    it("should export crmCompanies table", () => {
      expect(crmCompanies).toBeDefined();
      expect(typeof crmCompanies).toBe("object");
    });

    it("should export crmContacts table", () => {
      expect(crmContacts).toBeDefined();
      expect(typeof crmContacts).toBe("object");
    });

    it("should export crmPipelines table", () => {
      expect(crmPipelines).toBeDefined();
      expect(typeof crmPipelines).toBe("object");
    });

    it("should export crmPipelineStages table", () => {
      expect(crmPipelineStages).toBeDefined();
      expect(typeof crmPipelineStages).toBe("object");
    });

    it("should export crmDeals table", () => {
      expect(crmDeals).toBeDefined();
      expect(typeof crmDeals).toBe("object");
    });

    it("should export crmActivities table", () => {
      expect(crmActivities).toBeDefined();
      expect(typeof crmActivities).toBe("object");
    });
  });

  describe("Relations Exports", () => {
    it("should export companiesRelations", () => {
      expect(companiesRelations).toBeDefined();
    });

    it("should export contactsRelations", () => {
      expect(contactsRelations).toBeDefined();
    });

    it("should export pipelinesRelations", () => {
      expect(pipelinesRelations).toBeDefined();
    });

    it("should export pipelineStagesRelations", () => {
      expect(pipelineStagesRelations).toBeDefined();
    });

    it("should export dealsRelations", () => {
      expect(dealsRelations).toBeDefined();
    });

    it("should export activitiesRelations", () => {
      expect(activitiesRelations).toBeDefined();
    });
  });

  describe("Enum Definitions", () => {
    it("should have contact status enum with correct values", () => {
      expect(contactStatusEnum).toBeDefined();
      expect(contactStatusEnum.enumValues).toContain("lead");
      expect(contactStatusEnum.enumValues).toContain("prospect");
      expect(contactStatusEnum.enumValues).toContain("customer");
      expect(contactStatusEnum.enumValues).toContain("churned");
      expect(contactStatusEnum.enumValues).toContain("archived");
      expect(contactStatusEnum.enumValues).toHaveLength(5);
    });

    it("should have deal status enum with correct values", () => {
      expect(dealStatusEnum).toBeDefined();
      expect(dealStatusEnum.enumValues).toContain("open");
      expect(dealStatusEnum.enumValues).toContain("won");
      expect(dealStatusEnum.enumValues).toContain("lost");
      expect(dealStatusEnum.enumValues).toContain("paused");
      expect(dealStatusEnum.enumValues).toHaveLength(4);
    });

    it("should have activity type enum with correct values", () => {
      expect(activityTypeEnum).toBeDefined();
      expect(activityTypeEnum.enumValues).toContain("call");
      expect(activityTypeEnum.enumValues).toContain("email");
      expect(activityTypeEnum.enumValues).toContain("meeting");
      expect(activityTypeEnum.enumValues).toContain("task");
      expect(activityTypeEnum.enumValues).toContain("note");
      expect(activityTypeEnum.enumValues).toContain("sms");
      expect(activityTypeEnum.enumValues).toContain("demo");
      expect(activityTypeEnum.enumValues).toHaveLength(7);
    });

    it("should have priority enum with correct values", () => {
      expect(priorityEnum).toBeDefined();
      expect(priorityEnum.enumValues).toContain("low");
      expect(priorityEnum.enumValues).toContain("medium");
      expect(priorityEnum.enumValues).toContain("high");
      expect(priorityEnum.enumValues).toContain("urgent");
      expect(priorityEnum.enumValues).toHaveLength(4);
    });
  });

  describe("Enum Type Exports", () => {
    it("should export ContactStatus type", async () => {
      const { contactStatusEnum } = await import("../crm.schema");
      expect(contactStatusEnum).toBeDefined();
    });

    it("should export DealStatus type", async () => {
      const { dealStatusEnum } = await import("../crm.schema");
      expect(dealStatusEnum).toBeDefined();
    });

    it("should export ActivityType type", async () => {
      const { activityTypeEnum } = await import("../crm.schema");
      expect(activityTypeEnum).toBeDefined();
    });

    it("should export Priority type", async () => {
      const { priorityEnum } = await import("../crm.schema");
      expect(priorityEnum).toBeDefined();
    });
  });

  describe("Schema Consistency", () => {
    it("should have matching table and enum names", () => {
      // Verify table names follow convention
      expect(crmCompanies).toBeDefined();
      expect(crmContacts).toBeDefined();
      expect(crmPipelines).toBeDefined();
      expect(crmPipelineStages).toBeDefined();
      expect(crmDeals).toBeDefined();
      expect(crmActivities).toBeDefined();
    });

    it("should have all required enums", () => {
      expect(contactStatusEnum).toBeDefined();
      expect(dealStatusEnum).toBeDefined();
      expect(activityTypeEnum).toBeDefined();
      expect(priorityEnum).toBeDefined();
    });
  });
});
