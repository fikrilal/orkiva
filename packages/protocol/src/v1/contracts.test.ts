import { describe, expect, it } from "vitest";

import {
  CURRENT_MESSAGE_SCHEMA_VERSION,
  ackReadInputSchema,
  createThreadInputSchema,
  heartbeatSessionInputSchema,
  postMessageInputSchema,
  protocolErrorResponseSchema,
  readMessagesInputSchema,
  summarizeThreadInputSchema,
  triggerParticipantInputSchema,
  triggerParticipantOutputSchema,
  updateThreadStatusInputSchema
} from "./index.js";

describe("protocol v1 contracts", () => {
  it("validates create_thread payloads", () => {
    const parsed = createThreadInputSchema.parse({
      workspace_id: "wk_mobile_core",
      title: "Profile mapper review loop",
      type: "workflow",
      participants: ["executioner_agent", "reviewer_agent"]
    });

    expect(parsed.type).toBe("workflow");
    expect(parsed.participants).toHaveLength(2);
  });

  it("rejects invalid update_thread_status payloads", () => {
    const result = updateThreadStatusInputSchema.safeParse({
      thread_id: "th_01",
      status: "archived",
      reason: "invalid"
    });
    expect(result.success).toBe(false);
  });

  it("enforces schema_version rules for post_message", () => {
    const ok = postMessageInputSchema.safeParse({
      thread_id: "th_01",
      schema_version: CURRENT_MESSAGE_SCHEMA_VERSION,
      kind: "chat",
      body: "hello world"
    });
    expect(ok.success).toBe(true);

    const rejected = postMessageInputSchema.safeParse({
      thread_id: "th_01",
      schema_version: 2,
      kind: "chat",
      body: "hello world"
    });
    expect(rejected.success).toBe(false);
  });

  it("applies read_messages defaults", () => {
    const parsed = readMessagesInputSchema.parse({
      thread_id: "th_01"
    });

    expect(parsed.since_seq).toBe(0);
    expect(parsed.limit).toBe(50);
  });

  it("validates ack_read input constraints", () => {
    const success = ackReadInputSchema.safeParse({
      thread_id: "th_01",
      last_read_seq: 27
    });
    expect(success.success).toBe(true);

    const failure = ackReadInputSchema.safeParse({
      thread_id: "th_01",
      last_read_seq: -1
    });
    expect(failure.success).toBe(false);
  });

  it("applies summarize_thread defaults and max bound", () => {
    const defaults = summarizeThreadInputSchema.parse({ thread_id: "th_01" });
    expect(defaults.max_messages).toBe(200);

    const tooLarge = summarizeThreadInputSchema.safeParse({
      thread_id: "th_01",
      max_messages: 1001
    });
    expect(tooLarge.success).toBe(false);
  });

  it("validates heartbeat_session payload", () => {
    const parsed = heartbeatSessionInputSchema.parse({
      session_id: "sess_rv_12",
      runtime: "codex_cli",
      resumable: true,
      status: "idle"
    });
    expect(parsed.management_mode).toBe("unmanaged");
  });

  it("validates trigger_participant payloads", () => {
    const input = triggerParticipantInputSchema.parse({
      thread_id: "th_01",
      target_agent_id: "reviewer_agent",
      reason: "new_unread_messages",
      trigger_prompt: "Read unread messages and continue workflow."
    });
    expect(input.target_agent_id).toBe("reviewer_agent");

    const output = triggerParticipantOutputSchema.parse({
      trigger_id: "trg_req_01",
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
      triggered_at: "2026-02-18T10:00:00.000Z"
    });
    expect(output.fallback_action).toBe("resume_session");
  });

  it("validates normalized error envelope", () => {
    const parsed = protocolErrorResponseSchema.parse({
      error: {
        code: "UNAUTHORIZED",
        message: "Token missing"
      },
      request_id: "req_01"
    });
    expect(parsed.error.code).toBe("UNAUTHORIZED");
  });
});
