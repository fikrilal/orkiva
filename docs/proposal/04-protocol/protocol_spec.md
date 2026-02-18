# Protocol and MCP Tool Specification

## 1. Design Principles
- Chat-first communication must remain natural.
- Structured metadata must be optional but standardized.
- APIs must support idempotency and pagination.
- Protocol must be transport-agnostic behind MCP method surface.
- Caller identity must come from verified platform-issued auth claims.
- MVP scope is single-workspace (no cross-workspace federation).

## 1.1 Authentication Context
All MCP methods require platform-issued signed authentication context.

Required verified claims:
- `agent_id`
- `workspace_id`
- `role`
- `session_id`
- `iat`
- `exp`
- `jti`

Identity handling rule:
- Authorization and audit identity are derived from verified claims.
- If payload identity fields are present and conflict with verified claims, request is rejected.

## 1.2 Versioning and Scope Rules
- Endpoint major versioning starts at `/v1`.
- Payloads include `schema_version` for compatibility control.
- Event payloads may include `event_version` inside metadata when event schemas evolve.
- Cross-workspace calls are rejected in MVP scope.

## 2. Entities
## 2.1 Thread
Fields:
- `thread_id` (string, immutable)
- `workspace_id` (string)
- `title` (string)
- `type` (`conversation` | `workflow` | `incident`)
- `status` (`active` | `blocked` | `resolved` | `closed`)
- `participants` (list of agent IDs)
- `created_at`, `updated_at`

## 2.2 Message
Fields:
- `message_id` (string)
- `thread_id` (string)
- `schema_version` (int, required; initial value `1`)
- `seq` (int64, monotonic in thread)
- `sender_agent_id` (string)
- `sender_session_id` (string)
- `kind` (`chat` | `event` | `system`)
- `body` (string)
- `metadata` (object, optional)
- `in_reply_to` (message_id, optional)
- `idempotency_key` (string, optional but recommended)
- `created_at`

Notes:
- `sender_agent_id` and `sender_session_id` are server-authoritative values derived from verified auth claims.
- For `kind=event`, `metadata.event_version` is recommended when evolving event payload schema.

## 2.3 Participant Cursor
Fields:
- `thread_id`
- `agent_id`
- `last_read_seq`
- `last_acked_message_id`
- `updated_at`

## 2.4 Agent Session Registry
Fields:
- `agent_id`
- `workspace_id`
- `session_id`
- `runtime` (example: `codex_cli`)
- `management_mode` (`managed` | `unmanaged`)
- `resumable` (bool)
- `last_heartbeat_at`
- `status` (`active` | `idle` | `offline`)

## 3. MCP Methods
Caller identity for all methods is derived from verified auth claims. Method input fields containing caller identity are backward-compatibility hints and must match claims.

## 3.1 create_thread
Purpose:
- Create a new communication thread.

Input:
```json
{
  "workspace_id": "wk_mobile_core",
  "title": "Profile mapper review loop",
  "type": "workflow",
  "participants": ["executioner_agent", "reviewer_agent"],
  "created_by": "coordinator_agent"
}
```

Output:
```json
{
  "thread_id": "th_01JXYZ",
  "status": "active",
  "created_at": "2026-02-17T12:00:00Z"
}
```

## 3.1b get_thread
Purpose:
- Fetch thread metadata and participant set.

Input:
```json
{
  "thread_id": "th_01JXYZ"
}
```

Output:
```json
{
  "thread_id": "th_01JXYZ",
  "workspace_id": "wk_mobile_core",
  "title": "Profile mapper review loop",
  "type": "workflow",
  "status": "active",
  "participants": ["executioner_agent", "reviewer_agent"],
  "created_at": "2026-02-17T12:00:00Z",
  "updated_at": "2026-02-17T12:05:00Z"
}
```

## 3.2 post_message
Purpose:
- Post a new chat or event message.

Input:
```json
{
  "thread_id": "th_01JXYZ",
  "schema_version": 1,
  "sender_agent_id": "reviewer_agent",
  "sender_session_id": "sess_rv_12",
  "kind": "event",
  "body": "Blocking issue found in null fallback",
  "metadata": {
    "event_type": "finding_reported",
    "severity": "high",
    "file": "lib/features/profile/data/mappers/user_mapper.dart",
    "line": 42,
    "task_id": "TASK-219"
  },
  "idempotency_key": "rv-find-219-1"
}
```

Output:
```json
{
  "message_id": "msg_8ab2",
  "seq": 27,
  "thread_status": "active",
  "created_at": "2026-02-17T12:05:00Z"
}
```

Idempotency behavior:
- If `(thread_id, sender_agent_id, idempotency_key)` matches an existing message with the same payload shape, return the original message result.
- If the same tuple is reused with different payload content, return `IDEMPOTENCY_CONFLICT`.

## 3.3 read_messages
Purpose:
- Fetch ordered message stream after a cursor.

Input:
```json
{
  "thread_id": "th_01JXYZ",
  "agent_id": "executioner_agent",
  "since_seq": 21,
  "limit": 50
}
```

Output:
```json
{
  "messages": [
    {
      "message_id": "msg_8ab2",
      "seq": 27,
      "kind": "event",
      "body": "Blocking issue found in null fallback",
      "metadata": {
        "event_type": "finding_reported",
        "severity": "high"
      },
      "sender_agent_id": "reviewer_agent",
      "created_at": "2026-02-17T12:05:00Z"
    }
  ],
  "next_seq": 27,
  "has_more": false
}
```

## 3.4 ack_read
Purpose:
- Update participant read checkpoint.

Input:
```json
{
  "thread_id": "th_01JXYZ",
  "agent_id": "executioner_agent",
  "last_read_seq": 27
}
```

Output:
```json
{
  "ok": true,
  "updated_at": "2026-02-17T12:05:06Z"
}
```

Validation rules:
- `last_read_seq` must be monotonic per `(thread_id, agent_id)` (no regression).
- `last_read_seq` must not exceed latest known thread sequence.

## 3.5 update_thread_status
Purpose:
- Change thread status with reason and optional metadata.

Authority rule:
- Human operator and orchestrator can request override-oriented transitions.
- Worker agents are restricted from force-closing disputed threads.

Input:
```json
{
  "thread_id": "th_01JXYZ",
  "agent_id": "reviewer_agent",
  "status": "resolved",
  "reason": "all_findings_verified"
}
```

Output:
```json
{
  "thread_id": "th_01JXYZ",
  "status": "resolved",
  "updated_at": "2026-02-17T12:20:00Z"
}
```

## 3.6 summarize_thread
Purpose:
- Return compact summary to avoid long-context replay.

Input:
```json
{
  "thread_id": "th_01JXYZ",
  "max_messages": 200
}
```

Output:
```json
{
  "summary": "2 blocking findings reported; both resolved after commits abc1234 and def5678.",
  "open_items": [],
  "last_status": "resolved"
}
```

## 3.7 heartbeat_session
Purpose:
- Update session liveliness used by wake policies.

Input:
```json
{
  "agent_id": "reviewer_agent",
  "workspace_id": "wk_mobile_core",
  "session_id": "sess_rv_12",
  "runtime": "codex_cli",
  "resumable": true,
  "status": "idle"
}
```

Output:
```json
{
  "ok": true,
  "recorded_at": "2026-02-17T12:25:00Z"
}
```

## 3.8 trigger_participant
Purpose:
- Wake a dormant participant session when unread messages exist.

Default runtime policy:
- Autonomous trigger attempts target managed runtimes only.
- Unmanaged targets skip PTY-trigger path and use fallback flow (`resume` or spawn-to-managed).

Default collision policy:
- If human input is active on target runtime, trigger enters deferred state.
- Defer re-check interval: `5s`; quiet window: `20s`; max defer: `60s`.
- Force override requires explicit operator intent and audit metadata.

Input:
```json
{
  "thread_id": "th_01JXYZ",
  "target_agent_id": "reviewer_agent",
  "reason": "new_unread_messages",
  "trigger_prompt": "You have unread messages in thread th_01JXYZ. Read new messages, continue review workflow, and post status update."
}
```

Output:
```json
{
  "target_agent_id": "reviewer_agent",
  "action": "trigger_runtime",
  "result": "deferred",
  "defer_reason": "human_input_busy",
  "deferred_until": "2026-02-17T12:26:03Z",
  "fallback_action": "resume_session",
  "runtime_command": "codex exec resume sess_rv_12 \"You have unread messages in thread th_01JXYZ...\"",
  "triggered_at": "2026-02-17T12:25:03Z"
}
```

Codex CLI runtime notes:
- Preferred path: trigger live managed runtime via supervisor PTY delivery.
- First fallback: `codex exec resume <session_id> <prompt>`.
- Final fallback: if resume target is unavailable, launch a new session and include `summarize_thread` output in initial prompt.

## 4. Event Type Registry (Initial)
- `finding_reported`
- `fix_pushed`
- `re_review_requested`
- `finding_verified`
- `finding_rejected`
- `thread_escalated`
- `thread_resolved`

## 5. Message Lifecycle
1. Created
2. Persisted
3. Visible to recipients
4. Read/acked by participant(s)
5. Referenced by follow-up message/event

## 6. Error Model
Common errors:
- `UNAUTHORIZED`: caller identity invalid.
- `FORBIDDEN`: no access to thread/workspace.
- `OUT_OF_SCOPE_WORKSPACE`: cross-workspace call rejected in single-workspace MVP mode.
- `NOT_FOUND`: thread/message missing.
- `CONFLICT`: idempotency conflict or invalid state transition.
- `RATE_LIMITED`: message quota exceeded.
- `VALIDATION_ERROR`: malformed payload.
- `WAKE_FAILED`: runtime trigger failed and no fallback path configured.
- `UNMANAGED_RUNTIME`: target runtime is not supervisor-managed for autonomous trigger lane.
- `HUMAN_INPUT_COLLISION`: target runtime is temporarily busy with direct human input.
- `CLAIM_MISMATCH`: payload identity conflicts with verified auth claims.
- `INSUFFICIENT_AUTHORITY`: caller role not permitted to execute override transition.

Error envelope:
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "agent not allowed to post to this thread",
    "request_id": "req_1234"
  }
}
```

## 7. Idempotency Rules
- `post_message` with same `(thread_id, sender_agent_id, idempotency_key)` is treated as retry and returns original message ID.
- Reuse of the same tuple with different payload content must return `IDEMPOTENCY_CONFLICT`.
- Idempotency keys are retained for a configurable window (example: 24h).

## 8. Retention and Archival
- Personal MVP default: indefinite retention (no automatic expiry job).
- Archival/expiry policies are deferred to future enhancement.
- Audit event retention may be split from chat retention in later phases.

## 9. Compatibility Notes
- Endpoint baseline is `/v1`.
- Protocol payloads are JSON.
- Field additions must be backward-compatible.
- Deprecated fields must be announced and removed by versioning policy.
