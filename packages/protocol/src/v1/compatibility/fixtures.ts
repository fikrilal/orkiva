export type CompatibilityExpectation = "pass" | "fail";

export type CompatibilitySchemaId =
  | "thread_entity"
  | "message_entity"
  | "session_entity"
  | "post_message_input"
  | "read_messages_output"
  | "trigger_participant_output";

export interface CompatibilityFixtureCase {
  id: string;
  schema: CompatibilitySchemaId;
  expect: CompatibilityExpectation;
  payload: unknown;
}

export const compatibilityFixtures: readonly CompatibilityFixtureCase[] = [
  {
    id: "thread_legacy_without_escalation_fields",
    schema: "thread_entity",
    expect: "pass",
    payload: {
      thread_id: "th_compat_01",
      workspace_id: "wk_mobile_core",
      title: "Legacy thread payload",
      type: "workflow",
      status: "active",
      participants: ["executioner_agent", "reviewer_agent"],
      created_at: "2026-02-18T10:00:00.000Z",
      updated_at: "2026-02-18T10:05:00.000Z"
    }
  },
  {
    id: "thread_additive_with_escalation_fields",
    schema: "thread_entity",
    expect: "pass",
    payload: {
      thread_id: "th_compat_02",
      workspace_id: "wk_mobile_core",
      title: "Escalated thread payload",
      type: "incident",
      status: "blocked",
      escalation_owner_agent_id: "operator_oncall",
      escalation_assigned_by_agent_id: "coordinator_agent",
      escalation_assigned_at: "2026-02-18T11:00:00.000Z",
      participants: ["executioner_agent", "reviewer_agent", "operator_oncall"],
      created_at: "2026-02-18T10:30:00.000Z",
      updated_at: "2026-02-18T11:00:00.000Z"
    }
  },
  {
    id: "thread_incompatible_missing_required_status",
    schema: "thread_entity",
    expect: "fail",
    payload: {
      thread_id: "th_compat_03",
      workspace_id: "wk_mobile_core",
      title: "Missing status",
      type: "workflow",
      participants: ["executioner_agent"],
      created_at: "2026-02-18T10:00:00.000Z",
      updated_at: "2026-02-18T10:05:00.000Z"
    }
  },
  {
    id: "message_entity_legacy_event_without_event_version",
    schema: "message_entity",
    expect: "pass",
    payload: {
      message_id: "msg_compat_01",
      thread_id: "th_compat_01",
      schema_version: 1,
      seq: 7,
      sender_agent_id: "reviewer_agent",
      sender_session_id: "sess_rv_01",
      kind: "event",
      body: "Legacy event payload",
      metadata: {
        event_type: "finding_reported"
      },
      created_at: "2026-02-18T11:05:00.000Z"
    }
  },
  {
    id: "message_entity_additive_event_with_extra_metadata",
    schema: "message_entity",
    expect: "pass",
    payload: {
      message_id: "msg_compat_02",
      thread_id: "th_compat_01",
      schema_version: 1,
      seq: 8,
      sender_agent_id: "reviewer_agent",
      sender_session_id: "sess_rv_01",
      kind: "event",
      body: "Additive event payload",
      metadata: {
        event_type: "finding_reported",
        event_version: 2,
        severity: "high",
        location: "apps/bridge-api/src/app.ts:101"
      },
      created_at: "2026-02-18T11:06:00.000Z"
    }
  },
  {
    id: "message_entity_incompatible_schema_version",
    schema: "message_entity",
    expect: "fail",
    payload: {
      message_id: "msg_compat_03",
      thread_id: "th_compat_01",
      schema_version: 2,
      seq: 9,
      sender_agent_id: "reviewer_agent",
      sender_session_id: "sess_rv_01",
      kind: "chat",
      body: "Invalid schema version",
      created_at: "2026-02-18T11:07:00.000Z"
    }
  },
  {
    id: "message_entity_incompatible_invalid_event_version",
    schema: "message_entity",
    expect: "fail",
    payload: {
      message_id: "msg_compat_04",
      thread_id: "th_compat_01",
      schema_version: 1,
      seq: 10,
      sender_agent_id: "reviewer_agent",
      sender_session_id: "sess_rv_01",
      kind: "event",
      body: "Invalid explicit event version",
      metadata: {
        event_type: "finding_reported",
        event_version: 0
      },
      created_at: "2026-02-18T11:08:00.000Z"
    }
  },
  {
    id: "session_entity_legacy_shape",
    schema: "session_entity",
    expect: "pass",
    payload: {
      agent_id: "reviewer_agent",
      workspace_id: "wk_mobile_core",
      session_id: "sess_rv_12",
      runtime: "codex_cli",
      management_mode: "unmanaged",
      resumable: true,
      status: "idle",
      last_heartbeat_at: "2026-02-18T11:00:00.000Z"
    }
  },
  {
    id: "session_entity_incompatible_invalid_status",
    schema: "session_entity",
    expect: "fail",
    payload: {
      agent_id: "reviewer_agent",
      workspace_id: "wk_mobile_core",
      session_id: "sess_rv_12",
      runtime: "codex_cli",
      management_mode: "unmanaged",
      resumable: true,
      status: "paused",
      last_heartbeat_at: "2026-02-18T11:00:00.000Z"
    }
  },
  {
    id: "post_message_input_legacy_event_without_event_version",
    schema: "post_message_input",
    expect: "pass",
    payload: {
      thread_id: "th_compat_04",
      schema_version: 1,
      kind: "event",
      body: "Legacy post payload",
      metadata: {
        event_type: "finding_reported"
      }
    }
  },
  {
    id: "post_message_input_additive_event_metadata",
    schema: "post_message_input",
    expect: "pass",
    payload: {
      thread_id: "th_compat_04",
      schema_version: 1,
      kind: "event",
      body: "Additive post payload",
      metadata: {
        event_type: "finding_reported",
        event_version: 2,
        remediation_hint: "Add null guard"
      },
      idempotency_key: "compat-evt-01"
    }
  },
  {
    id: "post_message_input_incompatible_missing_required_body",
    schema: "post_message_input",
    expect: "fail",
    payload: {
      thread_id: "th_compat_04",
      schema_version: 1,
      kind: "chat"
    }
  },
  {
    id: "post_message_input_incompatible_invalid_event_version",
    schema: "post_message_input",
    expect: "fail",
    payload: {
      thread_id: "th_compat_04",
      schema_version: 1,
      kind: "event",
      body: "Invalid event version",
      metadata: {
        event_type: "finding_reported",
        event_version: -1
      }
    }
  },
  {
    id: "read_messages_output_legacy_event_without_event_version",
    schema: "read_messages_output",
    expect: "pass",
    payload: {
      messages: [
        {
          message_id: "msg_compat_10",
          schema_version: 1,
          seq: 10,
          kind: "event",
          body: "Legacy read payload",
          metadata: {
            event_type: "finding_reported"
          },
          sender_agent_id: "reviewer_agent",
          created_at: "2026-02-18T11:20:00.000Z"
        }
      ],
      next_seq: 10,
      has_more: false
    }
  },
  {
    id: "read_messages_output_additive_with_extra_metadata",
    schema: "read_messages_output",
    expect: "pass",
    payload: {
      messages: [
        {
          message_id: "msg_compat_11",
          schema_version: 1,
          seq: 11,
          kind: "event",
          body: "Additive read payload",
          metadata: {
            event_type: "finding_reported",
            event_version: 3,
            severity: "medium"
          },
          sender_agent_id: "reviewer_agent",
          created_at: "2026-02-18T11:21:00.000Z"
        },
        {
          message_id: "msg_compat_12",
          schema_version: 1,
          seq: 12,
          kind: "chat",
          body: "Follow-up chat",
          metadata: {
            context_label: "triage"
          },
          sender_agent_id: "executioner_agent",
          created_at: "2026-02-18T11:22:00.000Z"
        }
      ],
      next_seq: 12,
      has_more: false
    }
  },
  {
    id: "read_messages_output_incompatible_invalid_kind",
    schema: "read_messages_output",
    expect: "fail",
    payload: {
      messages: [
        {
          message_id: "msg_compat_13",
          schema_version: 1,
          seq: 13,
          kind: "notice",
          body: "Invalid kind",
          sender_agent_id: "reviewer_agent",
          created_at: "2026-02-18T11:23:00.000Z"
        }
      ],
      next_seq: 13,
      has_more: false
    }
  },
  {
    id: "trigger_participant_output_legacy_minimal",
    schema: "trigger_participant_output",
    expect: "pass",
    payload: {
      trigger_id: "trg_compat_01",
      target_agent_id: "reviewer_agent",
      action: "trigger_runtime",
      result: "queued",
      job_status: "queued",
      stale_session: false,
      triggered_at: "2026-02-18T11:30:00.000Z"
    }
  },
  {
    id: "trigger_participant_output_additive_runtime_details",
    schema: "trigger_participant_output",
    expect: "pass",
    payload: {
      trigger_id: "trg_compat_02",
      target_agent_id: "reviewer_agent",
      action: "fallback_required",
      result: "fallback_required",
      job_status: "fallback_resume",
      fallback_action: "resume_session",
      target_session_id: "sess_rv_12",
      runtime: "codex_cli",
      management_mode: "unmanaged",
      session_status: "idle",
      stale_session: false,
      triggered_at: "2026-02-18T11:31:00.000Z"
    }
  },
  {
    id: "trigger_participant_output_incompatible_invalid_job_status",
    schema: "trigger_participant_output",
    expect: "fail",
    payload: {
      trigger_id: "trg_compat_03",
      target_agent_id: "reviewer_agent",
      action: "trigger_runtime",
      result: "queued",
      job_status: "resumed",
      stale_session: false,
      triggered_at: "2026-02-18T11:32:00.000Z"
    }
  }
];
