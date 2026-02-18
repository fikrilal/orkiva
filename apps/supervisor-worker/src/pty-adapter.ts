import type { RuntimeRegistryRecord } from "./runtime-registry.js";

export const DEFAULT_TRIGGER_PAYLOAD_MAX_BYTES = 8192;

export type TriggerPayloadValidationErrorCode =
  | "TRIGGER_PAYLOAD_EMPTY"
  | "TRIGGER_PAYLOAD_TOO_LARGE";

export interface TriggerDeliveryRequest {
  runtime: RuntimeRegistryRecord;
  triggerId: string;
  threadId: string;
  reason: string;
  prompt: string;
}

export interface TriggerDeliverySuccess {
  delivered: true;
  details?: Record<string, unknown>;
}

export type TriggerDeliveryFailureCode =
  | TriggerPayloadValidationErrorCode
  | "UNSUPPORTED_RUNTIME"
  | "TARGET_NOT_FOUND"
  | "PANE_DEAD"
  | "SEND_KEYS_ERROR";

export interface TriggerDeliveryFailure {
  delivered: false;
  errorCode: TriggerDeliveryFailureCode;
  details?: Record<string, unknown>;
}

export type TriggerDeliveryResult = TriggerDeliverySuccess | TriggerDeliveryFailure;

export interface PreparedTriggerPayload {
  sanitizedPrompt: string;
  envelopeLines: readonly string[];
}

export type PreparedTriggerPayloadResult =
  | { ok: true; value: PreparedTriggerPayload }
  | {
      ok: false;
      errorCode: TriggerPayloadValidationErrorCode;
      details?: Record<string, unknown>;
    };

export interface TriggerPtyAdapter {
  deliver(input: TriggerDeliveryRequest): Promise<TriggerDeliveryResult>;
}

const isUnsupportedControlCharacter = (value: string): boolean => {
  const code = value.charCodeAt(0);
  return code <= 8 || (code >= 11 && code <= 31) || code === 127;
};

const normalizePrompt = (value: string): string => {
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  let sanitized = "";
  for (const character of normalized) {
    if (isUnsupportedControlCharacter(character)) {
      continue;
    }
    sanitized += character;
  }
  return sanitized;
};

const sanitizeEnvelopeToken = (value: string): string => value.replaceAll(/[^a-zA-Z0-9._:-]/g, "_");

export const prepareTriggerPayload = (
  input: {
    triggerId: string;
    threadId: string;
    reason: string;
    prompt: string;
  },
  maxPayloadBytes = DEFAULT_TRIGGER_PAYLOAD_MAX_BYTES
): PreparedTriggerPayloadResult => {
  const sanitizedPrompt = normalizePrompt(input.prompt);
  if (sanitizedPrompt.trim().length === 0) {
    return {
      ok: false,
      errorCode: "TRIGGER_PAYLOAD_EMPTY",
      details: {
        maxPayloadBytes
      }
    };
  }

  const payloadBytes = Buffer.byteLength(sanitizedPrompt, "utf8");
  if (payloadBytes > maxPayloadBytes) {
    return {
      ok: false,
      errorCode: "TRIGGER_PAYLOAD_TOO_LARGE",
      details: {
        maxPayloadBytes,
        payloadBytes
      }
    };
  }

  const header = `[BRIDGE_TRIGGER id=${sanitizeEnvelopeToken(input.triggerId)} thread=${sanitizeEnvelopeToken(input.threadId)} reason=${sanitizeEnvelopeToken(input.reason)}]`;
  const envelopeLines = [header, ...sanitizedPrompt.split("\n"), "[/BRIDGE_TRIGGER]"];

  return {
    ok: true,
    value: {
      sanitizedPrompt,
      envelopeLines
    }
  };
};
