import { describe, expect, it } from "vitest";

import { prepareTriggerPayload } from "./pty-adapter.js";

describe("prepareTriggerPayload", () => {
  it("builds a trigger envelope and strips unsupported control characters", () => {
    const result = prepareTriggerPayload({
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "line-1\u0007\r\nline-2\tok"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected payload preparation to succeed");
    }

    expect(result.value.sanitizedPrompt).toBe("line-1\nline-2\tok");
    expect(result.value.envelopeLines).toEqual([
      "[BRIDGE_TRIGGER id=trg_01 thread=th_01 reason=new_unread_messages]",
      "line-1",
      "line-2\tok",
      "[/BRIDGE_TRIGGER]"
    ]);
  });

  it("rejects empty payload after sanitization", () => {
    const result = prepareTriggerPayload({
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "\u0000\r\n\t  "
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "TRIGGER_PAYLOAD_EMPTY",
      details: {
        maxPayloadBytes: 8192
      }
    });
  });

  it("rejects payloads above max bytes", () => {
    const result = prepareTriggerPayload(
      {
        triggerId: "trg_01",
        threadId: "th_01",
        reason: "new_unread_messages",
        prompt: "123456"
      },
      5
    );

    expect(result).toEqual({
      ok: false,
      errorCode: "TRIGGER_PAYLOAD_TOO_LARGE",
      details: {
        maxPayloadBytes: 5,
        payloadBytes: 6
      }
    });
  });
});
