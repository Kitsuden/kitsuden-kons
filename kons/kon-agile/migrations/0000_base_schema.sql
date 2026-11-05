-- Base schema for kon-agile
-- ============================================================================
--
-- kon-agile declared THIRTEEN tables in its `kon.json` and had no
-- `migrations/` folder: not a single statement that created them. The kon could
-- be activated from the panel (the installer checked nothing) and from then on
-- every one of its screens failed.
--
-- It is the same gap that kon-dms and kon-esports had, with the same origin: the
-- schema lived only in `agile.schema.ts`, in Drizzle, and nobody translated it
-- to SQL. These thirteen tables were generated from that file.
--
-- Idempotent on purpose (`IF NOT EXISTS`, and the foreign keys inside a DO block
-- that checks `pg_constraint`): there may be databases where part of the schema
-- was created by hand while this was missing.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_cycle_status') THEN
    CREATE TYPE "public"."agile_cycle_status" AS ENUM('draft', 'started', 'completed', 'cancelled');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_estimate_type') THEN
    CREATE TYPE "public"."agile_estimate_type" AS ENUM('fibonacci', 'linear', 'tshirt', 'days', 'points');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_intake_status') THEN
    CREATE TYPE "public"."agile_intake_status" AS ENUM('pending', 'accepted', 'declined', 'duplicate', 'spam');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_issue_priority') THEN
    CREATE TYPE "public"."agile_issue_priority" AS ENUM('urgent', 'high', 'medium', 'low');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_issue_type') THEN
    CREATE TYPE "public"."agile_issue_type" AS ENUM('issue', 'feature', 'bug', 'improvement', 'epic', 'sub_issue', 'spike');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_link_type') THEN
    CREATE TYPE "public"."agile_link_type" AS ENUM('blocks', 'blocked_by', 'relates_to', 'duplicates', 'duplicate_of', 'parent_of', 'child_of');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_module_status') THEN
    CREATE TYPE "public"."agile_module_status" AS ENUM('backlog', 'planned', 'in_progress', 'paused', 'completed', 'cancelled');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'agile_state_group') THEN
    CREATE TYPE "public"."agile_state_group" AS ENUM('backlog', 'unstarted', 'started', 'completed', 'cancelled');
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" text NOT NULL,
	"field" text,
	"old_value" jsonb,
	"new_value" jsonb,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"project_id" uuid,
	"issue_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"content_html" text NOT NULL,
	"content_text" text,
	"created_by" text NOT NULL,
	"is_edited" boolean DEFAULT false,
	"edited_at" timestamp with time zone,
	"parent_id" uuid,
	"reactions" jsonb DEFAULT '{}'::jsonb,
	"access" text DEFAULT 'public',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_cycles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"start_date" timestamp with time zone NOT NULL,
	"end_date" timestamp with time zone NOT NULL,
	"status" "agile_cycle_status" DEFAULT 'draft' NOT NULL,
	"goal" text,
	"capacity" integer,
	"stats" jsonb DEFAULT '{}'::jsonb,
	"is_active" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"type" "agile_estimate_type" NOT NULL,
	"name" text NOT NULL,
	"custom_points" jsonb,
	"is_default" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"suggested_type" "agile_issue_type",
	"suggested_priority" "agile_issue_priority",
	"suggested_state_id" uuid,
	"source" text NOT NULL,
	"source_data" jsonb DEFAULT '{}'::jsonb,
	"status" "agile_intake_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_issue_id" uuid,
	"created_issue_key" text,
	"duplicate_of_id" uuid,
	"created_by" text,
	"created_by_email" text,
	"created_by_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_issue_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"link_type" "agile_link_type" NOT NULL,
	"relation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description_html" text,
	"description_text" text,
	"type" "agile_issue_type" DEFAULT 'issue' NOT NULL,
	"priority" "agile_issue_priority" DEFAULT 'medium' NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_id" uuid,
	"assignee_id" text,
	"created_by" text NOT NULL,
	"state_id" uuid NOT NULL,
	"cycle_id" uuid,
	"module_id" uuid,
	"sequence" integer DEFAULT 0,
	"sort_order" integer DEFAULT 0,
	"estimate" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"target_date" timestamp with time zone,
	"props" jsonb DEFAULT '{}'::jsonb,
	"is_draft" boolean DEFAULT false,
	"is_sub_issue" boolean DEFAULT false,
	"sub_issues_count" integer DEFAULT 0,
	"comments_count" integer DEFAULT 0,
	"attachments_count" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"color" text DEFAULT '#6366f1',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_module_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"module_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_modules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"lead_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" "agile_module_status" DEFAULT 'backlog' NOT NULL,
	"start_date" timestamp with time zone,
	"target_date" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"color" text DEFAULT '#6366f1',
	"stats" jsonb DEFAULT '{"progress":0}'::jsonb,
	"parent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"identifier" text NOT NULL,
	"description" text,
	"is_archived" boolean DEFAULT false,
	"lead_id" text,
	"default_assignee_id" text,
	"emoji" text DEFAULT '📁',
	"color" text DEFAULT '#6366f1',
	"key_counter" integer DEFAULT 0,
	"cover_image_id" uuid,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "agile_projects_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agile_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"group" "agile_state_group" NOT NULL,
	"color" text DEFAULT '#94a3b8',
	"sequence" integer DEFAULT 0,
	"is_default" boolean DEFAULT false,
	"is_completed" boolean DEFAULT false,
	"is_cancelled" boolean DEFAULT false,
	"validations" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_activity_log_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_activity_log" ADD CONSTRAINT "agile_activity_log_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_activity_log_issue_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_activity_log" ADD CONSTRAINT "agile_activity_log_issue_id_agile_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."agile_issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_comments_issue_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_comments" ADD CONSTRAINT "agile_comments_issue_id_agile_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."agile_issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_cycles_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_cycles" ADD CONSTRAINT "agile_cycles_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_estimates_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_estimates" ADD CONSTRAINT "agile_estimates_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_intakes_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_intakes" ADD CONSTRAINT "agile_intakes_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_intakes_suggested_state_id_agile_states_id_fk') THEN
    ALTER TABLE "agile_intakes" ADD CONSTRAINT "agile_intakes_suggested_state_id_agile_states_id_fk" FOREIGN KEY ("suggested_state_id") REFERENCES "public"."agile_states"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_intakes_created_issue_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_intakes" ADD CONSTRAINT "agile_intakes_created_issue_id_agile_issues_id_fk" FOREIGN KEY ("created_issue_id") REFERENCES "public"."agile_issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issue_labels_issue_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_issue_labels" ADD CONSTRAINT "agile_issue_labels_issue_id_agile_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."agile_issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issue_labels_label_id_agile_labels_id_fk') THEN
    ALTER TABLE "agile_issue_labels" ADD CONSTRAINT "agile_issue_labels_label_id_agile_labels_id_fk" FOREIGN KEY ("label_id") REFERENCES "public"."agile_labels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issue_links_source_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_issue_links" ADD CONSTRAINT "agile_issue_links_source_id_agile_issues_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."agile_issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issue_links_target_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_issue_links" ADD CONSTRAINT "agile_issue_links_target_id_agile_issues_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."agile_issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issues_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_issues" ADD CONSTRAINT "agile_issues_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issues_state_id_agile_states_id_fk') THEN
    ALTER TABLE "agile_issues" ADD CONSTRAINT "agile_issues_state_id_agile_states_id_fk" FOREIGN KEY ("state_id") REFERENCES "public"."agile_states"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issues_cycle_id_agile_cycles_id_fk') THEN
    ALTER TABLE "agile_issues" ADD CONSTRAINT "agile_issues_cycle_id_agile_cycles_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."agile_cycles"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_issues_module_id_agile_modules_id_fk') THEN
    ALTER TABLE "agile_issues" ADD CONSTRAINT "agile_issues_module_id_agile_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."agile_modules"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_labels_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_labels" ADD CONSTRAINT "agile_labels_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_module_issues_module_id_agile_modules_id_fk') THEN
    ALTER TABLE "agile_module_issues" ADD CONSTRAINT "agile_module_issues_module_id_agile_modules_id_fk" FOREIGN KEY ("module_id") REFERENCES "public"."agile_modules"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_module_issues_issue_id_agile_issues_id_fk') THEN
    ALTER TABLE "agile_module_issues" ADD CONSTRAINT "agile_module_issues_issue_id_agile_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."agile_issues"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_modules_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_modules" ADD CONSTRAINT "agile_modules_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agile_states_project_id_agile_projects_id_fk') THEN
    ALTER TABLE "agile_states" ADD CONSTRAINT "agile_states_project_id_agile_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."agile_projects"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issue_labels_unique_idx" ON "agile_issue_labels" USING btree ("issue_id","label_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issue_links_unique_idx" ON "agile_issue_links" USING btree ("source_id","target_id","link_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issues_key_idx" ON "agile_issues" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_issues_project_sequence_idx" ON "agile_issues" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_labels_project_name_idx" ON "agile_labels" USING btree ("project_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_module_issues_unique_idx" ON "agile_module_issues" USING btree ("module_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_projects_identifier_idx" ON "agile_projects" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agile_states_project_sequence_idx" ON "agile_states" USING btree ("project_id","sequence");