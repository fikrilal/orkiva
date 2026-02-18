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
