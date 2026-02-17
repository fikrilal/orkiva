CREATE TYPE "public"."management_mode" AS ENUM('managed', 'unmanaged');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('chat', 'event', 'system');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('active', 'idle', 'offline');--> statement-breakpoint
CREATE TYPE "public"."thread_status" AS ENUM('active', 'blocked', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."thread_type" AS ENUM('conversation', 'workflow', 'incident');--> statement-breakpoint
CREATE TYPE "public"."trigger_attempt_result" AS ENUM('delivered', 'deferred', 'timeout', 'failed', 'fallback_resume_started', 'fallback_resume_succeeded', 'fallback_resume_failed', 'fallback_spawned');--> statement-breakpoint
CREATE TYPE "public"."trigger_job_status" AS ENUM('queued', 'triggering', 'deferred', 'delivered', 'timeout', 'failed', 'fallback_resume', 'fallback_spawn');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"event_id" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"actor_agent_id" text,
	"actor_role" text,
	"operation" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"thread_id" text,
	"request_id" text,
	"result" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"seq" bigint NOT NULL,
	"sender_agent_id" text NOT NULL,
	"sender_session_id" text NOT NULL,
	"kind" "message_kind" NOT NULL,
	"body" text NOT NULL,
	"metadata" jsonb,
	"in_reply_to" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participant_cursors" (
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"last_read_seq" bigint DEFAULT 0 NOT NULL,
	"last_acked_message_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participant_cursors_pk" PRIMARY KEY("thread_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "session_registry" (
	"agent_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"session_id" text NOT NULL,
	"runtime" text NOT NULL,
	"management_mode" "management_mode" DEFAULT 'unmanaged' NOT NULL,
	"resumable" boolean DEFAULT false NOT NULL,
	"status" "session_status" DEFAULT 'offline' NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_registry_pk" PRIMARY KEY("agent_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "thread_participants" (
	"thread_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_participants_pk" PRIMARY KEY("thread_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"type" "thread_type" NOT NULL,
	"status" "thread_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_attempts" (
	"attempt_id" bigserial PRIMARY KEY NOT NULL,
	"trigger_id" text NOT NULL,
	"attempt_no" integer NOT NULL,
	"result" "trigger_attempt_result" NOT NULL,
	"error_code" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trigger_jobs" (
	"trigger_id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"target_agent_id" text NOT NULL,
	"target_session_id" text,
	"reason" text NOT NULL,
	"prompt" text NOT NULL,
	"status" "trigger_job_status" DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant_cursors" ADD CONSTRAINT "participant_cursors_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_participants" ADD CONSTRAINT "thread_participants_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_attempts" ADD CONSTRAINT "trigger_attempts_trigger_id_trigger_jobs_trigger_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."trigger_jobs"("trigger_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_jobs" ADD CONSTRAINT "trigger_jobs_thread_id_threads_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_idx" ON "audit_events" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "audit_events_thread_idx" ON "audit_events" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "audit_events_operation_idx" ON "audit_events" USING btree ("operation");--> statement-breakpoint
CREATE INDEX "audit_events_created_at_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_thread_seq_uk" ON "messages" USING btree ("thread_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_thread_sender_idempotency_uk" ON "messages" USING btree ("thread_id","sender_agent_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "messages_thread_created_idx" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_sender_idx" ON "messages" USING btree ("sender_agent_id");--> statement-breakpoint
CREATE INDEX "messages_in_reply_to_idx" ON "messages" USING btree ("in_reply_to");--> statement-breakpoint
CREATE INDEX "participant_cursors_agent_idx" ON "participant_cursors" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_registry_workspace_session_uk" ON "session_registry" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "session_registry_status_idx" ON "session_registry" USING btree ("status");--> statement-breakpoint
CREATE INDEX "session_registry_heartbeat_idx" ON "session_registry" USING btree ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX "thread_participants_agent_idx" ON "thread_participants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "threads_workspace_idx" ON "threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "threads_status_idx" ON "threads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "threads_workspace_status_idx" ON "threads" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_attempts_trigger_attempt_no_uk" ON "trigger_attempts" USING btree ("trigger_id","attempt_no");--> statement-breakpoint
CREATE INDEX "trigger_attempts_trigger_idx" ON "trigger_attempts" USING btree ("trigger_id");--> statement-breakpoint
CREATE INDEX "trigger_jobs_status_idx" ON "trigger_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "trigger_jobs_target_agent_idx" ON "trigger_jobs" USING btree ("target_agent_id");--> statement-breakpoint
CREATE INDEX "trigger_jobs_thread_idx" ON "trigger_jobs" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "trigger_jobs_workspace_idx" ON "trigger_jobs" USING btree ("workspace_id");