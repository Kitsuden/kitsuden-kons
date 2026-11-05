-- Base schema of kon-dms
-- ============================================================================
--
-- ── WHY THIS FILE DID NOT EXIST AND WAS NEEDED ─────────────────────────────
--
-- kon-dms shipped FOUR migrations and NONE of them created `dms_documents`. All four
-- started with an ALTER or a foreign key against that table, so the chain
-- failed on the FIRST statement of the FIRST migration:
--
--     ERROR:  relation "dms_documents" does not exist
--
-- The kon could only work on a database whose schema someone had
-- created by hand. On a clean installation it was impossible, and in the panel that
-- showed up as "Internal Server Error" on every Documents screen.
--
-- The eleven tables were generated from `dms.schema.ts`, which was the only
-- complete definition there was — and which nobody translated to SQL.
--
-- ── WHY IT IS IDEMPOTENT ───────────────────────────────────────────────────
--
-- `IF NOT EXISTS` everywhere, and the foreign keys inside a DO block that queries
-- `pg_constraint` (ADD CONSTRAINT does not accept IF NOT EXISTS). That way it can
-- be applied on a database where part of the schema was already created by hand, which is
-- exactly the situation the gap left behind.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dms_change_type') THEN
    CREATE TYPE "public"."dms_change_type" AS ENUM('major', 'minor', 'patch');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dms_document_status') THEN
    CREATE TYPE "public"."dms_document_status" AS ENUM('draft', 'in_review', 'approved', 'published', 'archived', 'deprecated');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dms_document_type') THEN
    CREATE TYPE "public"."dms_document_type" AS ENUM('manual', 'policy', 'procedure', 'template', 'guide', 'training', 'report', 'other');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dms_version_status') THEN
    CREATE TYPE "public"."dms_version_status" AS ENUM('draft', 'review_pending', 'changes_requested', 'approved', 'published', 'rejected');
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid,
	"version_id" uuid,
	"action" varchar(50) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" uuid,
	"user_id" uuid,
	"user_name" varchar(255),
	"user_email" varchar(255),
	"user_role" varchar(100),
	"details" jsonb DEFAULT '{}'::jsonb,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(255) NOT NULL,
	"description" text,
	"icon" varchar(50) DEFAULT 'Folder',
	"color" varchar(7) DEFAULT '#6366f1',
	"parent_id" uuid,
	"level" integer DEFAULT 0 NOT NULL,
	"path" varchar(1000) DEFAULT '' NOT NULL,
	"metadata_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allowed_roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"department_id" uuid,
	"sort_order" integer DEFAULT 0,
	"document_count" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_acknowledgments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"acknowledged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid,
	"parent_id" uuid,
	"user_id" uuid NOT NULL,
	"content" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_diagrams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"source_xml" text,
	"source_json" text,
	"rendered_svg" text,
	"media_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"filename" varchar(500) NOT NULL,
	"original_name" varchar(500) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum" varchar(64),
	"storage_provider" varchar(50) DEFAULT 'local' NOT NULL,
	"storage_path" varchar(1000) NOT NULL,
	"storage_bucket" varchar(255),
	"public_url" varchar(1000),
	"file_type" varchar(50) DEFAULT 'attachment' NOT NULL,
	"sort_order" integer DEFAULT 0,
	"extracted_text" text,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_document_id" uuid NOT NULL,
	"target_document_id" uuid NOT NULL,
	"relation_type" varchar(50) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_slug_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"old_slug" varchar(500) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" varchar(20) NOT NULL,
	"change_type" "dms_change_type" DEFAULT 'minor' NOT NULL,
	"content" text,
	"content_format" varchar(20) DEFAULT 'markdown',
	"changelog" text NOT NULL,
	"changes_from_previous" jsonb,
	"status" "dms_version_status" DEFAULT 'draft' NOT NULL,
	"created_by_id" uuid NOT NULL,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"approval_notes" text,
	"published_by_id" uuid,
	"published_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_latest" boolean DEFAULT false NOT NULL,
	"file_count" integer DEFAULT 0,
	"total_size_bytes" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(100) NOT NULL,
	"title" varchar(500) NOT NULL,
	"slug" varchar(500) NOT NULL,
	"description" text,
	"type" "dms_document_type" DEFAULT 'manual' NOT NULL,
	"category_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_version_id" uuid,
	"current_version_number" varchar(20) DEFAULT '0.0.0',
	"next_version_number" varchar(20) DEFAULT '1.0.0',
	"status" "dms_document_status" DEFAULT 'draft' NOT NULL,
	"owner_id" uuid NOT NULL,
	"reviewer_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approver_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" varchar(20) DEFAULT 'restricted' NOT NULL,
	"allowed_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"department_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"related_document_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"replaces_document_id" uuid,
	"effective_date" timestamp with time zone,
	"review_due_date" timestamp with time zone,
	"expiration_date" timestamp with time zone,
	"version_count" integer DEFAULT 0,
	"view_count" integer DEFAULT 0,
	"download_count" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"is_template" boolean DEFAULT false,
	"requires_acknowledgment" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dms_workflow_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid,
	"user_id" uuid NOT NULL,
	"type" varchar(50) NOT NULL,
	"message" text NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_access_log_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_access_log" ADD CONSTRAINT "dms_access_log_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_access_log_version_id_dms_document_versions_id_fk') THEN
    ALTER TABLE "dms_access_log" ADD CONSTRAINT "dms_access_log_version_id_dms_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dms_document_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_categories_parent_id_dms_categories_id_fk') THEN
    ALTER TABLE "dms_categories" ADD CONSTRAINT "dms_categories_parent_id_dms_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dms_categories"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_acknowledgments_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_acknowledgments" ADD CONSTRAINT "dms_document_acknowledgments_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_acknowledgments_version_id_dms_document_versions_id_fk') THEN
    ALTER TABLE "dms_document_acknowledgments" ADD CONSTRAINT "dms_document_acknowledgments_version_id_dms_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dms_document_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_comments_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_comments" ADD CONSTRAINT "dms_document_comments_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_comments_version_id_dms_document_versions_id_fk') THEN
    ALTER TABLE "dms_document_comments" ADD CONSTRAINT "dms_document_comments_version_id_dms_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dms_document_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_comments_parent_id_dms_document_comments_id_fk') THEN
    ALTER TABLE "dms_document_comments" ADD CONSTRAINT "dms_document_comments_parent_id_dms_document_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dms_document_comments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_diagrams_version_id_dms_document_versions_id_fk') THEN
    ALTER TABLE "dms_document_diagrams" ADD CONSTRAINT "dms_document_diagrams_version_id_dms_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dms_document_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_files_version_id_dms_document_versions_id_fk') THEN
    ALTER TABLE "dms_document_files" ADD CONSTRAINT "dms_document_files_version_id_dms_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dms_document_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_files_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_files" ADD CONSTRAINT "dms_document_files_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_relations_source_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_relations" ADD CONSTRAINT "dms_document_relations_source_document_id_dms_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_relations_target_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_relations" ADD CONSTRAINT "dms_document_relations_target_document_id_dms_documents_id_fk" FOREIGN KEY ("target_document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_slug_history_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_slug_history" ADD CONSTRAINT "dms_document_slug_history_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_document_versions_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_document_versions" ADD CONSTRAINT "dms_document_versions_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_documents_category_id_dms_categories_id_fk') THEN
    ALTER TABLE "dms_documents" ADD CONSTRAINT "dms_documents_category_id_dms_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."dms_categories"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_workflow_notifications_document_id_dms_documents_id_fk') THEN
    ALTER TABLE "dms_workflow_notifications" ADD CONSTRAINT "dms_workflow_notifications_document_id_dms_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."dms_documents"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dms_workflow_notifications_version_id_dms_document_versions_id_fk') THEN
    ALTER TABLE "dms_workflow_notifications" ADD CONSTRAINT "dms_workflow_notifications_version_id_dms_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."dms_document_versions"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_log_document_idx" ON "dms_access_log" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_log_user_idx" ON "dms_access_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_log_action_idx" ON "dms_access_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_log_created_idx" ON "dms_access_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dms_categories_slug_idx" ON "dms_categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_categories_parent_idx" ON "dms_categories" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_categories_path_idx" ON "dms_categories" USING btree ("path");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_categories_level_idx" ON "dms_categories" USING btree ("level");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dms_ack_doc_user_idx" ON "dms_document_acknowledgments" USING btree ("document_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_ack_version_idx" ON "dms_document_acknowledgments" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_comments_document_idx" ON "dms_document_comments" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_comments_user_idx" ON "dms_document_comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_comments_parent_idx" ON "dms_document_comments" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_diagrams_version_idx" ON "dms_document_diagrams" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_files_version_idx" ON "dms_document_files" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_files_document_idx" ON "dms_document_files" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_files_mime_idx" ON "dms_document_files" USING btree ("mime_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_rel_source_idx" ON "dms_document_relations" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_rel_target_idx" ON "dms_document_relations" USING btree ("target_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dms_doc_rel_unique_idx" ON "dms_document_relations" USING btree ("source_document_id","target_document_id","relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dms_slug_history_old_slug_idx" ON "dms_document_slug_history" USING btree ("old_slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_slug_history_document_idx" ON "dms_document_slug_history" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dms_doc_versions_doc_ver_idx" ON "dms_document_versions" USING btree ("document_id","version_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_versions_document_idx" ON "dms_document_versions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_versions_status_idx" ON "dms_document_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_doc_versions_is_latest_idx" ON "dms_document_versions" USING btree ("is_latest");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dms_documents_code_idx" ON "dms_documents" USING btree ("code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_documents_slug_idx" ON "dms_documents" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_documents_category_idx" ON "dms_documents" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_documents_status_idx" ON "dms_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_documents_type_idx" ON "dms_documents" USING btree ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_documents_owner_idx" ON "dms_documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_documents_review_due_idx" ON "dms_documents" USING btree ("review_due_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_notifications_document_idx" ON "dms_workflow_notifications" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_notifications_user_idx" ON "dms_workflow_notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dms_notifications_read_idx" ON "dms_workflow_notifications" USING btree ("read");