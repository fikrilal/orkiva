import { z } from "zod";

export const API_MAJOR_VERSION = "v1" as const;
export const CURRENT_MESSAGE_SCHEMA_VERSION = 1 as const;
export const CURRENT_EVENT_VERSION = 1 as const;

export const nonEmptyStringSchema = z.string().trim().min(1);
export const isoDatetimeSchema = z.string().datetime({ offset: true });

export const nonNegativeIntSchema = z.number().int().nonnegative();
export const positiveIntSchema = z.number().int().positive();
export const eventVersionSchema = positiveIntSchema;

export const paginationLimitSchema = positiveIntSchema.max(200);
export const pageSinceSeqSchema = nonNegativeIntSchema;

export const metadataSchema = z.record(z.unknown());

export const messageSchemaVersionSchema = z.literal(CURRENT_MESSAGE_SCHEMA_VERSION);

const isValidEventVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

export const hasExplicitInvalidEventVersion = (
  metadata: Record<string, unknown> | undefined
): boolean => {
  if (metadata === undefined) {
    return false;
  }
  const value = metadata["event_version"];
  return value !== undefined && !isValidEventVersion(value);
};

export const normalizeEventMetadata = (
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> => {
  const normalized: Record<string, unknown> = metadata === undefined ? {} : { ...metadata };
  if (!isValidEventVersion(normalized["event_version"])) {
    normalized["event_version"] = CURRENT_EVENT_VERSION;
  }

  return normalized;
};

export type MessageKindWithMetadata = "chat" | "event" | "system";

export const normalizeMetadataForMessageKind = (
  kind: MessageKindWithMetadata,
  metadata: unknown
): Record<string, unknown> | undefined => {
  if (kind === "event") {
    if (metadata === undefined || metadata === null || Array.isArray(metadata)) {
      return normalizeEventMetadata(undefined);
    }

    if (typeof metadata !== "object") {
      return normalizeEventMetadata(undefined);
    }

    return normalizeEventMetadata(metadata as Record<string, unknown>);
  }

  if (metadata === undefined || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }

  if (typeof metadata !== "object") {
    return undefined;
  }

  return { ...(metadata as Record<string, unknown>) };
};
