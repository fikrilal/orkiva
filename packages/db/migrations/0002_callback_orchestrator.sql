ALTER TYPE "public"."trigger_job_status" ADD VALUE IF NOT EXISTS 'callback_pending';--> statement-breakpoint
ALTER TYPE "public"."trigger_job_status" ADD VALUE IF NOT EXISTS 'callback_retry';--> statement-breakpoint
ALTER TYPE "public"."trigger_job_status" ADD VALUE IF NOT EXISTS 'callback_delivered';--> statement-breakpoint
ALTER TYPE "public"."trigger_job_status" ADD VALUE IF NOT EXISTS 'callback_failed';--> statement-breakpoint

ALTER TYPE "public"."trigger_attempt_result" ADD VALUE IF NOT EXISTS 'callback_post_succeeded';--> statement-breakpoint
ALTER TYPE "public"."trigger_attempt_result" ADD VALUE IF NOT EXISTS 'callback_post_deferred';--> statement-breakpoint
ALTER TYPE "public"."trigger_attempt_result" ADD VALUE IF NOT EXISTS 'callback_post_failed';
