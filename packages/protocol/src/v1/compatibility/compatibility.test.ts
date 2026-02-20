import { describe, expect, it } from "vitest";
import type { ZodTypeAny } from "zod";

import { CURRENT_EVENT_VERSION } from "../common.js";
import { messageEntitySchema, sessionEntitySchema, threadEntitySchema } from "../entities.js";
import { postMessageInputSchema, readMessagesOutputSchema } from "../message.js";
import { triggerParticipantOutputSchema } from "../session.js";
import {
  compatibilityFixtures,
  type CompatibilityFixtureCase,
  type CompatibilitySchemaId
} from "./fixtures.js";

const schemaRegistry: Record<CompatibilitySchemaId, ZodTypeAny> = {
  thread_entity: threadEntitySchema,
  message_entity: messageEntitySchema,
  session_entity: sessionEntitySchema,
  post_message_input: postMessageInputSchema,
  read_messages_output: readMessagesOutputSchema,
  trigger_participant_output: triggerParticipantOutputSchema
};

const getFixtureById = (id: string): CompatibilityFixtureCase => {
  const fixture = compatibilityFixtures.find((entry) => entry.id === id);
  if (fixture === undefined) {
    throw new Error(`Fixture not found: ${id}`);
  }

  return fixture;
};

describe("protocol v1 additive compatibility fixtures", () => {
  for (const fixture of compatibilityFixtures) {
    it(`case ${fixture.id} (${fixture.schema})`, () => {
      const schema = schemaRegistry[fixture.schema];
      const result = schema.safeParse(fixture.payload);
      expect(result.success).toBe(fixture.expect === "pass");
    });
  }

  it("normalizes event_version for legacy post_message fixture", () => {
    const fixture = getFixtureById("post_message_input_legacy_event_without_event_version");
    const parsed = postMessageInputSchema.parse(fixture.payload);

    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") {
      return;
    }

    expect(parsed.metadata?.["event_version"]).toBe(CURRENT_EVENT_VERSION);
  });

  it("normalizes event_version for legacy message entity fixture", () => {
    const fixture = getFixtureById("message_entity_legacy_event_without_event_version");
    const parsed = messageEntitySchema.parse(fixture.payload);

    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") {
      return;
    }

    expect(parsed.metadata?.["event_version"]).toBe(CURRENT_EVENT_VERSION);
  });

  it("normalizes event_version for legacy read_messages fixture", () => {
    const fixture = getFixtureById("read_messages_output_legacy_event_without_event_version");
    const parsed = readMessagesOutputSchema.parse(fixture.payload);

    const first = parsed.messages[0];
    expect(first?.kind).toBe("event");
    if (first === undefined || first.kind !== "event") {
      return;
    }

    expect(first.metadata["event_version"]).toBe(CURRENT_EVENT_VERSION);
  });
});
