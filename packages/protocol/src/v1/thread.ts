import { z } from "zod";

import { isoDatetimeSchema, nonEmptyStringSchema, positiveIntSchema } from "./common.js";
import { threadEntitySchema, threadStatusSchema, threadTypeSchema } from "./entities.js";

export const createThreadInputSchema = z.object({
  workspace_id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  type: threadTypeSchema,
  participants: z.array(nonEmptyStringSchema).min(1),
  created_by: nonEmptyStringSchema.optional()
});

export const createThreadOutputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  status: threadStatusSchema,
  created_at: isoDatetimeSchema
});

export const getThreadInputSchema = z.object({
  thread_id: nonEmptyStringSchema
});

export const getThreadOutputSchema = threadEntitySchema;

export const updateThreadStatusInputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  agent_id: nonEmptyStringSchema.optional(),
  status: threadStatusSchema,
  reason: nonEmptyStringSchema,
  metadata: z.record(z.unknown()).optional()
});

export const updateThreadStatusOutputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  status: threadStatusSchema,
  updated_at: isoDatetimeSchema
});

export const summarizeThreadInputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  max_messages: positiveIntSchema.max(1000).optional().default(200)
});

export const summarizeThreadOutputSchema = z.object({
  summary: nonEmptyStringSchema,
  open_items: z.array(nonEmptyStringSchema),
  last_status: threadStatusSchema
});
