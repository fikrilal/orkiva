import { z } from "zod";

import {
  hasExplicitInvalidEventVersion,
  isoDatetimeSchema,
  messageSchemaVersionSchema,
  metadataSchema,
  nonEmptyStringSchema,
  nonNegativeIntSchema,
  normalizeEventMetadata,
  pageSinceSeqSchema,
  paginationLimitSchema,
  positiveIntSchema
} from "./common.js";
import { threadStatusSchema } from "./entities.js";

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
})
  .superRefine((input, ctx) => {
    if (input.kind !== "event") {
      return;
    }
    if (hasExplicitInvalidEventVersion(input.metadata)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata", "event_version"],
        message: '"metadata.event_version" must be a positive integer'
      });
    }
  })
  .transform((input) =>
    input.kind === "event"
      ? {
          ...input,
          metadata: normalizeEventMetadata(input.metadata)
        }
      : input
  );

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

const readMessageBaseSchema = z.object({
  message_id: nonEmptyStringSchema,
  schema_version: messageSchemaVersionSchema,
  seq: positiveIntSchema,
  body: nonEmptyStringSchema,
  sender_agent_id: nonEmptyStringSchema,
  created_at: isoDatetimeSchema
});

const readEventMessageSchema = readMessageBaseSchema
  .extend({
    kind: z.literal("event"),
    metadata: metadataSchema.optional()
  })
  .superRefine((message, ctx) => {
    if (hasExplicitInvalidEventVersion(message.metadata)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["metadata", "event_version"],
        message: '"metadata.event_version" must be a positive integer'
      });
    }
  })
  .transform((message) => ({
    ...message,
    metadata: normalizeEventMetadata(message.metadata)
  }));

const readNonEventMessageSchema = readMessageBaseSchema.extend({
  kind: z.enum(["chat", "system"]),
  metadata: metadataSchema.optional()
});

export const readMessagesOutputSchema = z.object({
  messages: z.array(z.union([readEventMessageSchema, readNonEventMessageSchema])),
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
