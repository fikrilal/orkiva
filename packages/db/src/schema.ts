import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

export const threadTypeEnum = pgEnum("thread_type", ["conversation", "workflow", "incident"]);
export const threadStatusEnum = pgEnum("thread_status", [
  "active",
  "blocked",
  "resolved",
  "closed"
]);
export const messageKindEnum = pgEnum("message_kind", ["chat", "event", "system"]);
export const managementModeEnum = pgEnum("management_mode", ["managed", "unmanaged"]);
export const sessionStatusEnum = pgEnum("session_status", ["active", "idle", "offline"]);
export const triggerJobStatusEnum = pgEnum("trigger_job_status", [
  "queued",
  "triggering",
  "deferred",
  "delivered",
  "timeout",
  "failed",
  "fallback_resume",
  "fallback_spawn"
]);
export const triggerAttemptResultEnum = pgEnum("trigger_attempt_result", [
  "delivered",
  "deferred",
  "timeout",
  "failed",
  "fallback_resume_started",
  "fallback_resume_succeeded",
  "fallback_resume_failed",
  "fallback_spawned"
]);

export const threads = pgTable(
  "threads",
  {
    threadId: text("thread_id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    type: threadTypeEnum("type").notNull(),
    status: threadStatusEnum("status").notNull().default("active"),
    escalationOwnerAgentId: text("escalation_owner_agent_id"),
    escalationAssignedByAgentId: text("escalation_assigned_by_agent_id"),
    escalationAssignedAt: timestamp("escalation_assigned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("threads_workspace_idx").on(table.workspaceId),
    index("threads_status_idx").on(table.status),
    index("threads_workspace_status_idx").on(table.workspaceId, table.status),
    index("threads_escalation_owner_idx").on(table.escalationOwnerAgentId)
  ]
);

export const threadParticipants = pgTable(
  "thread_participants",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.threadId, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.agentId],
      name: "thread_participants_pk"
    }),
    index("thread_participants_agent_idx").on(table.agentId)
  ]
);

export const messages = pgTable(
  "messages",
  {
    messageId: text("message_id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.threadId, { onDelete: "cascade" }),
    schemaVersion: integer("schema_version").notNull().default(1),
    seq: bigint("seq", { mode: "number" }).notNull(),
    senderAgentId: text("sender_agent_id").notNull(),
    senderSessionId: text("sender_session_id").notNull(),
    kind: messageKindEnum("kind").notNull(),
    body: text("body").notNull(),
    metadata: jsonb("metadata"),
    inReplyTo: text("in_reply_to"),
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("messages_thread_seq_uk").on(table.threadId, table.seq),
    uniqueIndex("messages_thread_sender_idempotency_uk").on(
      table.threadId,
      table.senderAgentId,
      table.idempotencyKey
    ),
    index("messages_thread_created_idx").on(table.threadId, table.createdAt),
    index("messages_sender_idx").on(table.senderAgentId),
    index("messages_in_reply_to_idx").on(table.inReplyTo)
  ]
);

export const participantCursors = pgTable(
  "participant_cursors",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.threadId, { onDelete: "cascade" }),
    agentId: text("agent_id").notNull(),
    lastReadSeq: bigint("last_read_seq", { mode: "number" }).notNull().default(0),
    lastAckedMessageId: text("last_acked_message_id"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.agentId],
      name: "participant_cursors_pk"
    }),
    index("participant_cursors_agent_idx").on(table.agentId)
  ]
);

export const sessionRegistry = pgTable(
  "session_registry",
  {
    agentId: text("agent_id").notNull(),
    workspaceId: text("workspace_id").notNull(),
    sessionId: text("session_id").notNull(),
    runtime: text("runtime").notNull(),
    managementMode: managementModeEnum("management_mode").notNull().default("unmanaged"),
    resumable: boolean("resumable").notNull().default(false),
    status: sessionStatusEnum("status").notNull().default("offline"),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({
      columns: [table.agentId, table.workspaceId],
      name: "session_registry_pk"
    }),
    uniqueIndex("session_registry_workspace_session_uk").on(table.workspaceId, table.sessionId),
    index("session_registry_status_idx").on(table.status),
    index("session_registry_heartbeat_idx").on(table.lastHeartbeatAt)
  ]
);

export const triggerJobs = pgTable(
  "trigger_jobs",
  {
    triggerId: text("trigger_id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.threadId, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    targetAgentId: text("target_agent_id").notNull(),
    targetSessionId: text("target_session_id"),
    reason: text("reason").notNull(),
    prompt: text("prompt").notNull(),
    status: triggerJobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxRetries: integer("max_retries").notNull().default(2),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("trigger_jobs_status_idx").on(table.status),
    index("trigger_jobs_target_agent_idx").on(table.targetAgentId),
    index("trigger_jobs_thread_idx").on(table.threadId),
    index("trigger_jobs_workspace_idx").on(table.workspaceId)
  ]
);

export const triggerAttempts = pgTable(
  "trigger_attempts",
  {
    attemptId: bigserial("attempt_id", { mode: "number" }).primaryKey(),
    triggerId: text("trigger_id")
      .notNull()
      .references(() => triggerJobs.triggerId, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    result: triggerAttemptResultEnum("result").notNull(),
    errorCode: text("error_code"),
    details: jsonb("details"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("trigger_attempts_trigger_attempt_no_uk").on(table.triggerId, table.attemptNo),
    index("trigger_attempts_trigger_idx").on(table.triggerId)
  ]
);

export const auditEvents = pgTable(
  "audit_events",
  {
    eventId: bigserial("event_id", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    actorAgentId: text("actor_agent_id"),
    actorRole: text("actor_role"),
    operation: text("operation").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    threadId: text("thread_id"),
    requestId: text("request_id"),
    result: text("result").notNull(),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("audit_events_workspace_idx").on(table.workspaceId),
    index("audit_events_thread_idx").on(table.threadId),
    index("audit_events_operation_idx").on(table.operation),
    index("audit_events_created_at_idx").on(table.createdAt)
  ]
);

export const threadRelations = relations(threads, ({ many }) => ({
  participants: many(threadParticipants),
  messages: many(messages),
  cursors: many(participantCursors),
  triggerJobs: many(triggerJobs)
}));

export const threadParticipantsRelations = relations(threadParticipants, ({ one }) => ({
  thread: one(threads, {
    fields: [threadParticipants.threadId],
    references: [threads.threadId]
  })
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, {
    fields: [messages.threadId],
    references: [threads.threadId]
  }),
  parent: one(messages, {
    fields: [messages.inReplyTo],
    references: [messages.messageId]
  })
}));

export const participantCursorsRelations = relations(participantCursors, ({ one }) => ({
  thread: one(threads, {
    fields: [participantCursors.threadId],
    references: [threads.threadId]
  }),
  lastAckedMessage: one(messages, {
    fields: [participantCursors.lastAckedMessageId],
    references: [messages.messageId]
  })
}));

export const triggerJobsRelations = relations(triggerJobs, ({ one, many }) => ({
  thread: one(threads, {
    fields: [triggerJobs.threadId],
    references: [threads.threadId]
  }),
  attempts: many(triggerAttempts)
}));

export const triggerAttemptsRelations = relations(triggerAttempts, ({ one }) => ({
  trigger: one(triggerJobs, {
    fields: [triggerAttempts.triggerId],
    references: [triggerJobs.triggerId]
  })
}));

export const setUpdatedAtTriggerFn = sql`
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
`;
