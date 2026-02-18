import { z } from "zod";

import {
  isoDatetimeSchema,
  messageSchemaVersionSchema,
  metadataSchema,
  nonEmptyStringSchema,
  nonNegativeIntSchema,
  pageSinceSeqSchema,
  paginationLimitSchema,
  positiveIntSchema
} from "./common.js";
import { messageEntitySchema, threadStatusSchema } from "./entities.js";

export const postMessageInputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  schema_version: messageSchemaVersionSchema,
  sender_agent_id: nonEmptyStringSchema.optional(),
  sender_session_id: nonEmptyStringSchema.optional(),
  kind: z.enum(["chat", "event", "system"]),
  body: nonEmptyStringSchema,
  metadata: metadataSchema.optional(),
  in_reply_to: nonEmptyStringSchema.optional(),
  idempotency_key: nonEmptyStringSchema.optional()
});

export const postMessageOutputSchema = z.object({
  message_id: nonEmptyStringSchema,
  seq: positiveIntSchema,
  thread_status: threadStatusSchema,
  created_at: isoDatetimeSchema
});

export const readMessagesInputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  agent_id: nonEmptyStringSchema.optional(),
  since_seq: pageSinceSeqSchema.optional().default(0),
  limit: paginationLimitSchema.optional().default(50)
});

export const readMessagesOutputSchema = z.object({
  messages: z.array(
    messageEntitySchema.pick({
      message_id: true,
      schema_version: true,
      seq: true,
      kind: true,
      body: true,
      metadata: true,
      sender_agent_id: true,
      created_at: true
    })
  ),
  next_seq: nonNegativeIntSchema,
  has_more: z.boolean()
});

export const ackReadInputSchema = z.object({
  thread_id: nonEmptyStringSchema,
  agent_id: nonEmptyStringSchema.optional(),
  last_read_seq: nonNegativeIntSchema
});

export const ackReadOutputSchema = z.object({
  ok: z.literal(true),
  updated_at: isoDatetimeSchema
});
