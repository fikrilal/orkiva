import { z } from "zod";

import { isoDatetimeSchema, nonEmptyStringSchema } from "./common.js";
import { managementModeSchema, sessionStatusSchema } from "./entities.js";

export const heartbeatSessionInputSchema = z.object({
  agent_id: nonEmptyStringSchema.optional(),
  workspace_id: nonEmptyStringSchema.optional(),
  session_id: nonEmptyStringSchema,
  runtime: nonEmptyStringSchema,
  management_mode: managementModeSchema.optional().default("unmanaged"),
  resumable: z.boolean(),
  status: sessionStatusSchema
});

export const heartbeatSessionOutputSchema = z.object({
  ok: z.literal(true),
  recorded_at: isoDatetimeSchema
});

export const triggerJobStatusSchema = z.enum([
  "queued",
  "triggering",
  "deferred",
  "delivered",
  "timeout",
  "failed",
  "fallback_resume",
  "fallback_spawn",
  "callback_pending",
  "callback_retry",
  "callback_delivered",
  "callback_failed"
]);

export const triggerParticipantActionSchema = z.enum(["trigger_runtime", "fallback_required"]);
export const triggerParticipantResultSchema = z.enum(["queued", "fallback_required"]);
export const triggerParticipantFallbackActionSchema = z.enum(["resume_session", "spawn_session"]);

export const triggerParticipantInputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  target_agent_id: nonEmptyStringSchema,
  reason: nonEmptyStringSchema,
  trigger_prompt: nonEmptyStringSchema
});

export const triggerParticipantOutputSchema = z.object({
  trigger_id: nonEmptyStringSchema,
  target_agent_id: nonEmptyStringSchema,
  action: triggerParticipantActionSchema,
  result: triggerParticipantResultSchema,
  job_status: triggerJobStatusSchema,
  fallback_action: triggerParticipantFallbackActionSchema.optional(),
  target_session_id: nonEmptyStringSchema.optional(),
  runtime: nonEmptyStringSchema.optional(),
  management_mode: managementModeSchema.optional(),
  session_status: sessionStatusSchema.optional(),
  stale_session: z.boolean(),
  triggered_at: isoDatetimeSchema
});
