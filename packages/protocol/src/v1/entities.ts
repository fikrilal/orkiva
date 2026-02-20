import { z } from "zod";

import {
  isoDatetimeSchema,
  messageSchemaVersionSchema,
  metadataSchema,
  nonEmptyStringSchema,
  nonNegativeIntSchema,
  positiveIntSchema
} from "./common.js";

export const threadTypeSchema = z.enum(["conversation", "workflow", "incident"]);
export const threadStatusSchema = z.enum(["active", "blocked", "resolved", "closed"]);

export const messageKindSchema = z.enum(["chat", "event", "system"]);
export const managementModeSchema = z.enum(["managed", "unmanaged"]);
export const sessionStatusSchema = z.enum(["active", "idle", "offline"]);

export const threadEntitySchema = z.object({
  thread_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  type: threadTypeSchema,
  status: threadStatusSchema,
  participants: z.array(nonEmptyStringSchema),
  created_at: isoDatetimeSchema,
  updated_at: isoDatetimeSchema
});

export const messageEntitySchema = z.object({
  message_id: nonEmptyStringSchema,
  thread_id: nonEmptyStringSchema,
  schema_version: messageSchemaVersionSchema,
  seq: positiveIntSchema,
  sender_agent_id: nonEmptyStringSchema,
  sender_session_id: nonEmptyStringSchema,
  kind: messageKindSchema,
  body: nonEmptyStringSchema,
  metadata: metadataSchema.optional(),
  in_reply_to: nonEmptyStringSchema.optional(),
  idempotency_key: nonEmptyStringSchema.optional(),
  created_at: isoDatetimeSchema
});

export const participantCursorEntitySchema = z.object({
  thread_id: nonEmptyStringSchema,
  agent_id: nonEmptyStringSchema,
  last_read_seq: nonNegativeIntSchema,
  last_acked_message_id: nonEmptyStringSchema.nullable(),
  updated_at: isoDatetimeSchema
});

export const sessionEntitySchema = z.object({
  agent_id: nonEmptyStringSchema,
  workspace_id: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema,
  runtime: nonEmptyStringSchema,
  management_mode: managementModeSchema,
  resumable: z.boolean(),
  status: sessionStatusSchema,
  last_heartbeat_at: isoDatetimeSchema
});
