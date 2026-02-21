ALTER TYPE "public"."trigger_job_status" ADD VALUE IF NOT EXISTS 'fallback_running';--> statement-breakpoint

ALTER TYPE "public"."trigger_attempt_result" ADD VALUE IF NOT EXISTS 'fallback_terminal_succeeded';--> statement-breakpoint
ALTER TYPE "public"."trigger_attempt_result" ADD VALUE IF NOT EXISTS 'fallback_terminal_failed';--> statement-breakpoint
ALTER TYPE "public"."trigger_attempt_result" ADD VALUE IF NOT EXISTS 'fallback_terminal_timed_out';--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."fallback_run_status" AS ENUM('running', 'completed', 'failed', 'timed_out', 'killed', 'orphaned');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 CREATE TYPE "public"."fallback_launch_mode" AS ENUM('resume', 'spawn');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "trigger_fallback_runs" (
  "trigger_id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "target_agent_id" text NOT NULL,
  "launch_mode" "fallback_launch_mode" NOT NULL,
  "pid" integer NOT NULL,
  "status" "fallback_run_status" DEFAULT 'running' NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "deadline_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "exit_code" integer,
  "error_code" text,
  "details" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "trigger_fallback_runs"
   ADD CONSTRAINT "trigger_fallback_runs_trigger_id_trigger_jobs_trigger_id_fk"
   FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger_jobs"("trigger_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "trigger_fallback_runs"
   ADD CONSTRAINT "trigger_fallback_runs_thread_id_threads_thread_id_fk"
   FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "trigger_fallback_runs_workspace_idx"
  ON "trigger_fallback_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trigger_fallback_runs_status_idx"
  ON "trigger_fallback_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trigger_fallback_runs_workspace_status_idx"
  ON "trigger_fallback_runs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trigger_fallback_runs_thread_idx"
  ON "trigger_fallback_runs" USING btree ("thread_id");
