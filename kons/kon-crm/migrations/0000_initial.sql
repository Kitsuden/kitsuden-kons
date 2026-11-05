-- Kitsuden CRM Kon - Initial Migration
-- Tables: contacts, companies, deals, activities, pipelines, pipeline_stages

-- ============================================
-- ENUMS
-- ============================================
CREATE TYPE "crm_contact_status" AS ENUM ('lead', 'prospect', 'customer', 'churned', 'archived');
CREATE TYPE "crm_deal_status" AS ENUM ('open', 'won', 'lost', 'paused');
CREATE TYPE "crm_activity_type" AS ENUM ('call', 'email', 'meeting', 'task', 'note', 'sms', 'demo');
CREATE TYPE "crm_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- ============================================
-- COMPANIES
-- ============================================
CREATE TABLE "crm_companies" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "domain" TEXT,
  "industry" TEXT,
  "size" TEXT, -- '1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'
  "website" TEXT,
  "linkedin" TEXT,
  "address" TEXT,
  "city" TEXT,
  "country" TEXT,
  "phone" TEXT,
  "description" TEXT,
  "logo" TEXT, -- URL to media
  "annual_revenue" INTEGER,
  "metadata" JSONB DEFAULT '{}',
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW(),
  "created_by" TEXT,
  "organization_id" TEXT
);

CREATE INDEX "idx_crm_companies_name" ON "crm_companies"("name");
CREATE INDEX "idx_crm_companies_industry" ON "crm_companies"("industry");
CREATE INDEX "idx_crm_companies_organization" ON "crm_companies"("organization_id");

-- ============================================
-- CONTACTS
-- ============================================
CREATE TABLE "crm_contacts" (
  "id" TEXT PRIMARY KEY,
  "first_name" TEXT NOT NULL,
  "last_name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "mobile" TEXT,
  "job_title" TEXT,
  "department" TEXT,
  "avatar" TEXT, -- URL to media
  
  -- CRM fields
  "status" "crm_contact_status" DEFAULT 'lead',
  "source" TEXT, -- 'website', 'referral', 'social', 'event', 'manual', etc.
  "score" INTEGER DEFAULT 0, -- Lead scoring 0-100
  
  -- Relations
  "company_id" TEXT REFERENCES "crm_companies"("id") ON DELETE SET NULL,
  "assigned_to" TEXT, -- User ID
  
  -- Social
  "linkedin" TEXT,
  "twitter" TEXT,
  
  -- Address
  "address" TEXT,
  "city" TEXT,
  "country" TEXT,
  
  -- Metadata
  "notes" TEXT,
  "tags" JSONB DEFAULT '[]',
  "custom_fields" JSONB DEFAULT '{}',
  "last_contacted_at" TIMESTAMP,
  "metadata" JSONB DEFAULT '{}',
  
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW(),
  "created_by" TEXT,
  "organization_id" TEXT
);

CREATE INDEX "idx_crm_contacts_name" ON "crm_contacts"("last_name", "first_name");
CREATE INDEX "idx_crm_contacts_email" ON "crm_contacts"("email");
CREATE INDEX "idx_crm_contacts_status" ON "crm_contacts"("status");
CREATE INDEX "idx_crm_contacts_company" ON "crm_contacts"("company_id");
CREATE INDEX "idx_crm_contacts_assigned" ON "crm_contacts"("assigned_to");
CREATE INDEX "idx_crm_contacts_organization" ON "crm_contacts"("organization_id");

-- ============================================
-- PIPELINES
-- ============================================
CREATE TABLE "crm_pipelines" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "is_default" BOOLEAN DEFAULT FALSE,
  "currency" TEXT DEFAULT 'USD',
  "metadata" JSONB DEFAULT '{}',
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW(),
  "created_by" TEXT,
  "organization_id" TEXT
);

CREATE INDEX "idx_crm_pipelines_default" ON "crm_pipelines"("is_default") WHERE "is_default" = TRUE;
CREATE INDEX "idx_crm_pipelines_organization" ON "crm_pipelines"("organization_id");

-- ============================================
-- PIPELINE STAGES
-- ============================================
CREATE TABLE "crm_pipeline_stages" (
  "id" TEXT PRIMARY KEY,
  "pipeline_id" TEXT NOT NULL REFERENCES "crm_pipelines"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "color" TEXT DEFAULT '#3b82f6',
  "order" INTEGER NOT NULL DEFAULT 0,
  "probability" INTEGER DEFAULT 0, -- Win probability % for this stage
  "wip_limit" INTEGER, -- Kanban WIP limit
  "metadata" JSONB DEFAULT '{}',
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW()
);

CREATE INDEX "idx_crm_pipeline_stages_pipeline" ON "crm_pipeline_stages"("pipeline_id");
CREATE INDEX "idx_crm_pipeline_stages_order" ON "crm_pipeline_stages"("pipeline_id", "order");

-- ============================================
-- DEALS
-- ============================================
CREATE TABLE "crm_deals" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "description" TEXT,
  
  -- Value
  "value" INTEGER NOT NULL DEFAULT 0, -- in cents (e.g., 10000 = $100.00)
  "currency" TEXT DEFAULT 'USD',
  
  -- Status & Stage
  "status" "crm_deal_status" DEFAULT 'open',
  "pipeline_id" TEXT NOT NULL REFERENCES "crm_pipelines"("id") ON DELETE CASCADE,
  "stage_id" TEXT NOT NULL REFERENCES "crm_pipeline_stages"("id") ON DELETE CASCADE,
  "probability" INTEGER DEFAULT 0, -- 0-100
  
  -- Relations
  "contact_id" TEXT REFERENCES "crm_contacts"("id") ON DELETE SET NULL,
  "company_id" TEXT REFERENCES "crm_companies"("id") ON DELETE SET NULL,
  "assigned_to" TEXT, -- User ID
  
  -- Dates
  "expected_close_date" DATE,
  "actual_close_date" DATE,
  "last_activity_at" TIMESTAMP,
  
  -- Source
  "source" TEXT,
  "campaign" TEXT,
  
  -- Metadata
  "tags" JSONB DEFAULT '[]',
  "custom_fields" JSONB DEFAULT '{}',
  "metadata" JSONB DEFAULT '{}',
  
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW(),
  "created_by" TEXT,
  "organization_id" TEXT
);

CREATE INDEX "idx_crm_deals_title" ON "crm_deals"("title");
CREATE INDEX "idx_crm_deals_status" ON "crm_deals"("status");
CREATE INDEX "idx_crm_deals_pipeline" ON "crm_deals"("pipeline_id");
CREATE INDEX "idx_crm_deals_stage" ON "crm_deals"("stage_id");
CREATE INDEX "idx_crm_deals_contact" ON "crm_deals"("contact_id");
CREATE INDEX "idx_crm_deals_company" ON "crm_deals"("company_id");
CREATE INDEX "idx_crm_deals_assigned" ON "crm_deals"("assigned_to");
CREATE INDEX "idx_crm_deals_expected_close" ON "crm_deals"("expected_close_date");
CREATE INDEX "idx_crm_deals_organization" ON "crm_deals"("organization_id");

-- ============================================
-- ACTIVITIES
-- ============================================
CREATE TABLE "crm_activities" (
  "id" TEXT PRIMARY KEY,
  "type" "crm_activity_type" NOT NULL,
  "subject" TEXT NOT NULL,
  "description" TEXT,
  
  -- Relations
  "contact_id" TEXT REFERENCES "crm_contacts"("id") ON DELETE CASCADE,
  "company_id" TEXT REFERENCES "crm_companies"("id") ON DELETE CASCADE,
  "deal_id" TEXT REFERENCES "crm_deals"("id") ON DELETE CASCADE,
  
  -- Assignment
  "assigned_to" TEXT, -- User ID who should complete
  "created_by" TEXT, -- User ID who created
  
  -- Scheduling
  "due_date" TIMESTAMP,
  "completed_at" TIMESTAMP,
  "duration_minutes" INTEGER, -- For calls/meetings
  
  -- Outcome
  "outcome" TEXT, -- 'successful', 'no_answer', 'left_message', 'callback', etc.
  "notes" TEXT,
  
  -- Metadata
  "metadata" JSONB DEFAULT '{}',
  "created_at" TIMESTAMP DEFAULT NOW(),
  "updated_at" TIMESTAMP DEFAULT NOW(),
  "organization_id" TEXT
);

CREATE INDEX "idx_crm_activities_type" ON "crm_activities"("type");
CREATE INDEX "idx_crm_activities_contact" ON "crm_activities"("contact_id");
CREATE INDEX "idx_crm_activities_company" ON "crm_activities"("company_id");
CREATE INDEX "idx_crm_activities_deal" ON "crm_activities"("deal_id");
CREATE INDEX "idx_crm_activities_assigned" ON "crm_activities"("assigned_to");
CREATE INDEX "idx_crm_activities_due" ON "crm_activities"("due_date");
CREATE INDEX "idx_crm_activities_completed" ON "crm_activities"("completed_at");
CREATE INDEX "idx_crm_activities_organization" ON "crm_activities"("organization_id");

-- ============================================
-- DEFAULT PIPELINE
-- ============================================
INSERT INTO "crm_pipelines" ("id", "name", "description", "is_default", "currency", "created_at", "updated_at")
VALUES (
  'pipeline_default_sales',
  'Sales Pipeline',
  'Default sales pipeline for tracking deals from lead to close',
  TRUE,
  'USD',
  NOW(),
  NOW()
);

-- Default stages for sales pipeline
INSERT INTO "crm_pipeline_stages" ("id", "pipeline_id", "name", "color", "order", "probability", "created_at", "updated_at")
VALUES 
  ('stage_lead', 'pipeline_default_sales', 'Lead', '#6b7280', 0, 10, NOW(), NOW()),
  ('stage_qualified', 'pipeline_default_sales', 'Qualified', '#3b82f6', 1, 25, NOW(), NOW()),
  ('stage_proposal', 'pipeline_default_sales', 'Proposal Sent', '#f59e0b', 2, 50, NOW(), NOW()),
  ('stage_negotiation', 'pipeline_default_sales', 'Negotiation', '#f97316', 3, 75, NOW(), NOW()),
  ('stage_closed_won', 'pipeline_default_sales', 'Closed Won', '#10b981', 4, 100, NOW(), NOW()),
  ('stage_closed_lost', 'pipeline_default_sales', 'Closed Lost', '#ef4444', 5, 0, NOW(), NOW());
