-- kon-esports base schema
-- ============================================================================
--
-- ── WHY THIS FILE DID NOT EXIST AND WAS NEEDED ─────────────────────────────
--
-- kon-esports shipped ELEVEN migrations and none of them created its tables.
-- The first one (`0000_rename_tables.sql`) RENAMES tables —`players` ->
-- `esports_players`— assuming they already exist from an earlier version of
-- the core. On a fresh database they do not exist, the rename does nothing,
-- and from the third migration on the chain breaks:
--
--     ERROR:  type "esports_match_status" does not exist
--
-- In other words: the kon could only be installed on top of a legacy schema
-- that nobody has any more. This file creates the fifteen tables from
-- `esports.schema.ts`, the only complete definition that existed.
--
-- It runs BEFORE the rename on purpose: on a legacy database the old tables
-- are still there under their short names, the `CREATE TABLE IF NOT EXISTS`
-- here creates whichever are missing, and the rename that follows still
-- makes sense.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_bracket_format') THEN
    CREATE TYPE "public"."esports_bracket_format" AS ENUM('single_elimination', 'double_elimination', 'round_robin', 'swiss');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_bracket_side') THEN
    CREATE TYPE "public"."esports_bracket_side" AS ENUM('winners', 'losers', 'grand_final');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_match_status') THEN
    CREATE TYPE "public"."esports_match_status" AS ENUM('Pending', 'Ready', 'InProgress', 'Completed', 'Bye', 'Void');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_participant_status') THEN
    CREATE TYPE "public"."esports_participant_status" AS ENUM('Pending', 'Approved', 'Rejected');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_seed_method') THEN
    CREATE TYPE "public"."esports_seed_method" AS ENUM('as_entered', 'random', 'by_rating');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_tournament_format') THEN
    CREATE TYPE "public"."esports_tournament_format" AS ENUM('1v1', 'Team');
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esports_tournament_status') THEN
    CREATE TYPE "public"."esports_tournament_status" AS ENUM('Draft', 'Open', 'InProgress', 'Completed');
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_match_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_id" uuid NOT NULL,
	"reported_by" uuid NOT NULL,
	"winner_id" uuid NOT NULL,
	"score_1" integer,
	"score_2" integer,
	"by_staff" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"phase_id" uuid,
	"round" integer NOT NULL,
	"match_order" integer NOT NULL,
	"bracket_match_id" varchar(20),
	"bracket_side" "esports_bracket_side" DEFAULT 'winners' NOT NULL,
	"participant_1_id" uuid,
	"participant_2_id" uuid,
	"next_match_id" uuid,
	"loser_next_match_id" uuid,
	"dq_participant_id" uuid,
	"participant_1_score" integer DEFAULT 0 NOT NULL,
	"participant_2_score" integer DEFAULT 0 NOT NULL,
	"winner_id" uuid,
	"status" "esports_match_status" DEFAULT 'Pending' NOT NULL,
	"station_id" uuid,
	"stream_id" uuid,
	"stream_queue_position" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"participant_id" uuid,
	"type" varchar(40) NOT NULL,
	"dedupe_key" varchar(160) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_phase_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase_id" uuid NOT NULL,
	"participant_id" uuid NOT NULL,
	"group" integer DEFAULT 1 NOT NULL,
	"seed" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_phases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"order" integer NOT NULL,
	"name" varchar(80) NOT NULL,
	"format" "esports_bracket_format" DEFAULT 'double_elimination' NOT NULL,
	"groups" integer DEFAULT 1 NOT NULL,
	"advances_per_group" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_players" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" varchar(200) NOT NULL,
	"country" varchar(2),
	"avatar_id" uuid,
	"bio" text,
	"social_links" text,
	"core_user_id" uuid,
	"external_source" varchar(20),
	"external_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_players_to_teams" (
	"player_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"role" varchar(20) DEFAULT 'player',
	"joined_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_prize_pool_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"contributors" integer,
	"source" varchar(20) DEFAULT 'matcherino' NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_report_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"media_id" uuid,
	"url" text,
	"caption" varchar(300),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_stations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"name" varchar(60) NOT NULL,
	"kind" varchar(20) DEFAULT 'physical' NOT NULL,
	"access_details" text,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"platform" varchar(20) NOT NULL,
	"channel" varchar(120) NOT NULL,
	"title" varchar(160),
	"viewer_access" varchar(20) DEFAULT 'public' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_team_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"invited_user_id" text,
	"invited_handle" varchar(120),
	"token" varchar(64) NOT NULL,
	"role" varchar(20) DEFAULT 'player' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"invited_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"logo_id" uuid,
	"captain_id" uuid,
	"created_by_user_id" text,
	"external_source" varchar(20),
	"external_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_tournament_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tournament_id" uuid NOT NULL,
	"player_id" uuid,
	"team_id" uuid,
	"status" "esports_participant_status" DEFAULT 'Pending' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"seed" integer,
	"rating" integer,
	"eliminated" boolean DEFAULT false NOT NULL,
	"registered_by_user_id" text,
	"waitlist_position" integer,
	"guest_email" varchar(160),
	"access_token_hash" varchar(64),
	"custom_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dropped_at" timestamp with time zone,
	"accepted_rules_at" timestamp with time zone,
	"contact_handle" varchar(120),
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "esports_tournaments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(200) NOT NULL,
	"game_id" uuid NOT NULL,
	"format" "esports_tournament_format" DEFAULT '1v1' NOT NULL,
	"max_participants" integer NOT NULL,
	"status" "esports_tournament_status" DEFAULT 'Draft' NOT NULL,
	"bracket_format" "esports_bracket_format" DEFAULT 'single_elimination' NOT NULL,
	"seed_method" "esports_seed_method" DEFAULT 'as_entered' NOT NULL,
	"shuffle_seed" integer,
	"champion_id" uuid,
	"check_in_opens_at" timestamp with time zone,
	"check_in_closes_at" timestamp with time zone,
	"registration_mode" varchar(20) DEFAULT 'closed' NOT NULL,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"waitlist_enabled" boolean DEFAULT false NOT NULL,
	"rules_text" text,
	"requires_rules_acceptance" boolean DEFAULT false NOT NULL,
	"report_grace_minutes" integer DEFAULT 0 NOT NULL,
	"min_roster_size" integer,
	"max_roster_size" integer,
	"allow_guest_registration" boolean DEFAULT true NOT NULL,
	"requires_evidence" boolean DEFAULT false NOT NULL,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"swiss_rounds" integer,
	"external_source" varchar(20),
	"external_id" varchar(64),
	"external_url" text,
	"prize_pool_cents" integer,
	"prize_pool_currency" varchar(3),
	"prize_pool_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_match_reports_match_id_esports_matches_id_fk') THEN
    ALTER TABLE "esports_match_reports" ADD CONSTRAINT "esports_match_reports_match_id_esports_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."esports_matches"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_match_reports_reported_by_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_match_reports" ADD CONSTRAINT "esports_match_reports_reported_by_esports_tournament_participants_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_match_reports_winner_id_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_match_reports" ADD CONSTRAINT "esports_match_reports_winner_id_esports_tournament_participants_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_matches_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_matches" ADD CONSTRAINT "esports_matches_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_matches_participant_1_id_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_matches" ADD CONSTRAINT "esports_matches_participant_1_id_esports_tournament_participants_id_fk" FOREIGN KEY ("participant_1_id") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_matches_participant_2_id_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_matches" ADD CONSTRAINT "esports_matches_participant_2_id_esports_tournament_participants_id_fk" FOREIGN KEY ("participant_2_id") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_matches_winner_id_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_matches" ADD CONSTRAINT "esports_matches_winner_id_esports_tournament_participants_id_fk" FOREIGN KEY ("winner_id") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_notifications_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_notifications" ADD CONSTRAINT "esports_notifications_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_notifications_participant_id_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_notifications" ADD CONSTRAINT "esports_notifications_participant_id_esports_tournament_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_phase_entries_phase_id_esports_phases_id_fk') THEN
    ALTER TABLE "esports_phase_entries" ADD CONSTRAINT "esports_phase_entries_phase_id_esports_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."esports_phases"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_phase_entries_participant_id_esports_tournament_participants_id_fk') THEN
    ALTER TABLE "esports_phase_entries" ADD CONSTRAINT "esports_phase_entries_participant_id_esports_tournament_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."esports_tournament_participants"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_phases_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_phases" ADD CONSTRAINT "esports_phases_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_players_to_teams_player_id_esports_players_id_fk') THEN
    ALTER TABLE "esports_players_to_teams" ADD CONSTRAINT "esports_players_to_teams_player_id_esports_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."esports_players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_players_to_teams_team_id_esports_teams_id_fk') THEN
    ALTER TABLE "esports_players_to_teams" ADD CONSTRAINT "esports_players_to_teams_team_id_esports_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."esports_teams"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_prize_pool_snapshots_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_prize_pool_snapshots" ADD CONSTRAINT "esports_prize_pool_snapshots_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_report_evidence_report_id_esports_match_reports_id_fk') THEN
    ALTER TABLE "esports_report_evidence" ADD CONSTRAINT "esports_report_evidence_report_id_esports_match_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."esports_match_reports"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_stations_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_stations" ADD CONSTRAINT "esports_stations_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_streams_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_streams" ADD CONSTRAINT "esports_streams_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_team_invites_team_id_esports_teams_id_fk') THEN
    ALTER TABLE "esports_team_invites" ADD CONSTRAINT "esports_team_invites_team_id_esports_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."esports_teams"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_teams_captain_id_esports_players_id_fk') THEN
    ALTER TABLE "esports_teams" ADD CONSTRAINT "esports_teams_captain_id_esports_players_id_fk" FOREIGN KEY ("captain_id") REFERENCES "public"."esports_players"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_tournament_participants_tournament_id_esports_tournaments_id_fk') THEN
    ALTER TABLE "esports_tournament_participants" ADD CONSTRAINT "esports_tournament_participants_tournament_id_esports_tournaments_id_fk" FOREIGN KEY ("tournament_id") REFERENCES "public"."esports_tournaments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_tournament_participants_player_id_esports_players_id_fk') THEN
    ALTER TABLE "esports_tournament_participants" ADD CONSTRAINT "esports_tournament_participants_player_id_esports_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."esports_players"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'esports_tournament_participants_team_id_esports_teams_id_fk') THEN
    ALTER TABLE "esports_tournament_participants" ADD CONSTRAINT "esports_tournament_participants_team_id_esports_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."esports_teams"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "match_reports_match_idx" ON "esports_match_reports" USING btree ("match_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_dedupe_unique" ON "esports_notifications" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_pending_idx" ON "esports_notifications" USING btree ("tournament_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phase_entries_unique" ON "esports_phase_entries" USING btree ("phase_id","participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phases_order_unique" ON "esports_phases" USING btree ("tournament_id","order");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "players_alias_idx" ON "esports_players" USING btree ("alias");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pt_unique" ON "esports_players_to_teams" USING btree ("player_id","team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prize_snapshots_tournament_idx" ON "esports_prize_pool_snapshots" USING btree ("tournament_id","captured_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_evidence_report_idx" ON "esports_report_evidence" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stations_tournament_idx" ON "esports_stations" USING btree ("tournament_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "streams_tournament_idx" ON "esports_streams" USING btree ("tournament_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_invites_token_unique" ON "esports_team_invites" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invites_team_idx" ON "esports_team_invites" USING btree ("team_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_name_idx" ON "esports_teams" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tp_player_unique" ON "esports_tournament_participants" USING btree ("tournament_id","player_id") WHERE "esports_tournament_participants"."player_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tp_team_unique" ON "esports_tournament_participants" USING btree ("tournament_id","team_id") WHERE "esports_tournament_participants"."team_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tp_user_unique" ON "esports_tournament_participants" USING btree ("tournament_id","registered_by_user_id") WHERE "esports_tournament_participants"."registered_by_user_id" is not null;