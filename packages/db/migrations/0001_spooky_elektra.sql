ALTER TABLE "threads" ADD COLUMN "escalation_owner_agent_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "escalation_assigned_by_agent_id" text;--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "escalation_assigned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "threads_escalation_owner_idx" ON "threads" USING btree ("escalation_owner_agent_id");