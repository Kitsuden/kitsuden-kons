-- kon-directory base schema
-- ============================================================================
--
-- The fourth kon with the same gap as dms, esports and agile: its only migration
-- RENAMES six tables —`organizations` -> `directory_organizations`— assuming
-- they exist from an earlier version of the core. On a fresh install they do
-- not exist, the rename does nothing, and the kon ends up with none of its
-- tables.
--
-- It can be activated from the panel, and every one of its screens fails. The
-- schema verifier caught it when run with `--all-kons` against a clean
-- database; until then only ACTIVE kons were checked, and this one ships off
-- by default — so nobody ever checked it.
--
-- The six tables were generated from `directory.schema.ts`. This runs BEFORE
-- the rename: on a legacy database the rename still makes sense, and the
-- free-target checks make it harmless.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'directory_employee_status') THEN
    CREATE TYPE "public"."directory_employee_status" AS ENUM('active', 'on_leave', 'remote', 'terminated', 'contractor', 'intern');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'directory_employment_type') THEN
    CREATE TYPE "public"."directory_employment_type" AS ENUM('full_time', 'part_time', 'contract', 'intern', 'freelance');
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"description" text,
	"parent_department_id" uuid,
	"level" integer DEFAULT 0 NOT NULL,
	"head_id" uuid,
	"email" varchar(255),
	"phone" varchar(50),
	"location" varchar(500),
	"cost_center" varchar(100),
	"is_active" boolean DEFAULT true NOT NULL,
	"employee_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_employee_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" varchar(50) NOT NULL,
	"description" text,
	"media_id" uuid NOT NULL,
	"issue_date" date,
	"expiry_date" date,
	"document_number" varchar(100),
	"is_confidential" boolean DEFAULT false,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" uuid NOT NULL,
	"employee_id" varchar(100) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"display_name" varchar(200),
	"email" varchar(255) NOT NULL,
	"work_email" varchar(255),
	"phone" varchar(50),
	"mobile" varchar(50),
	"photo_id" uuid,
	"department_id" uuid,
	"position_id" uuid,
	"manager_id" uuid,
	"status" "directory_employee_status" DEFAULT 'active' NOT NULL,
	"employment_type" "directory_employment_type" DEFAULT 'full_time' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"birth_date" date,
	"location" varchar(200),
	"timezone" varchar(50),
	"remote" boolean DEFAULT false,
	"salary_band" varchar(20),
	"skills" jsonb DEFAULT '[]'::jsonb,
	"languages" jsonb DEFAULT '[]'::jsonb,
	"bio" text,
	"linkedin" varchar(500),
	"github" varchar(500),
	"twitter" varchar(500),
	"website" varchar(500),
	"emergency_contact" jsonb,
	"custom_fields" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"visible_in_directory" boolean DEFAULT true,
	"source" varchar(50) DEFAULT 'manual',
	"external_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_org_chart_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"path" jsonb NOT NULL,
	"level" integer NOT NULL,
	"direct_reports" jsonb DEFAULT '[]'::jsonb,
	"total_reports" integer DEFAULT 0,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"description" text,
	"website" varchar(500),
	"email" varchar(255),
	"phone" varchar(50),
	"address" text,
	"city" varchar(100),
	"state" varchar(100),
	"country" varchar(100),
	"postal_code" varchar(20),
	"logo_id" uuid,
	"primary_color" varchar(7),
	"is_active" boolean DEFAULT true NOT NULL,
	"employee_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "directory_organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"slug" varchar(200) NOT NULL,
	"description" text,
	"level" varchar(50),
	"grade" varchar(20),
	"department_id" uuid,
	"reports_to_position_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_management" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_departments_organization_id_directory_organizations_id_fk') THEN
    ALTER TABLE "directory_departments" ADD CONSTRAINT "directory_departments_organization_id_directory_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."directory_organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_employee_documents_employee_id_directory_employees_id_fk') THEN
    ALTER TABLE "directory_employee_documents" ADD CONSTRAINT "directory_employee_documents_employee_id_directory_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."directory_employees"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_employees_organization_id_directory_organizations_id_fk') THEN
    ALTER TABLE "directory_employees" ADD CONSTRAINT "directory_employees_organization_id_directory_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."directory_organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_employees_department_id_directory_departments_id_fk') THEN
    ALTER TABLE "directory_employees" ADD CONSTRAINT "directory_employees_department_id_directory_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."directory_departments"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_employees_position_id_directory_positions_id_fk') THEN
    ALTER TABLE "directory_employees" ADD CONSTRAINT "directory_employees_position_id_directory_positions_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."directory_positions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_org_chart_cache_organization_id_directory_organizations_id_fk') THEN
    ALTER TABLE "directory_org_chart_cache" ADD CONSTRAINT "directory_org_chart_cache_organization_id_directory_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."directory_organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_org_chart_cache_employee_id_directory_employees_id_fk') THEN
    ALTER TABLE "directory_org_chart_cache" ADD CONSTRAINT "directory_org_chart_cache_employee_id_directory_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."directory_employees"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_positions_organization_id_directory_organizations_id_fk') THEN
    ALTER TABLE "directory_positions" ADD CONSTRAINT "directory_positions_organization_id_directory_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."directory_organizations"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'directory_positions_department_id_directory_departments_id_fk') THEN
    ALTER TABLE "directory_positions" ADD CONSTRAINT "directory_positions_department_id_directory_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."directory_departments"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_dept_org_slug_idx" ON "directory_departments" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_departments_org_idx" ON "directory_departments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_departments_parent_idx" ON "directory_departments" USING btree ("parent_department_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_departments_head_idx" ON "directory_departments" USING btree ("head_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_departments_active_idx" ON "directory_departments" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_emp_docs_employee_idx" ON "directory_employee_documents" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_emp_docs_type_idx" ON "directory_employee_documents" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_emp_docs_expiry_idx" ON "directory_employee_documents" USING btree ("expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_employees_org_empid_idx" ON "directory_employees" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_employees_email_idx" ON "directory_employees" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_org_idx" ON "directory_employees" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_dept_idx" ON "directory_employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_position_idx" ON "directory_employees" USING btree ("position_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_manager_idx" ON "directory_employees" USING btree ("manager_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_status_idx" ON "directory_employees" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_active_idx" ON "directory_employees" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_employees_name_idx" ON "directory_employees" USING btree ("first_name","last_name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_orgchart_org_emp_idx" ON "directory_org_chart_cache" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_orgchart_org_idx" ON "directory_org_chart_cache" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_orgchart_level_idx" ON "directory_org_chart_cache" USING btree ("level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_organizations_slug_idx" ON "directory_organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_organizations_active_idx" ON "directory_organizations" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_pos_org_slug_idx" ON "directory_positions" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_positions_org_idx" ON "directory_positions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_positions_dept_idx" ON "directory_positions" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_positions_active_idx" ON "directory_positions" USING btree ("is_active");