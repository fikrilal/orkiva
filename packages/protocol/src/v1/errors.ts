import { z } from "zod";

import { isoDatetimeSchema, nonEmptyStringSchema } from "./common.js";

export const protocolErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "CONFLICT",
  "WORKSPACE_MISMATCH",
  "INVALID_THREAD_TRANSITION",
  "IDEMPOTENCY_CONFLICT",
  "RATE_LIMITED",
  "INTERNAL"
]);

export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>;

export const protocolErrorSchema = z.object({
  code: protocolErrorCodeSchema,
  message: nonEmptyStringSchema,
  details: z.record(z.unknown()).optional(),
  retryable: z.boolean().optional()
});

export const protocolErrorResponseSchema = z.object({
  error: protocolErrorSchema,
  request_id: nonEmptyStringSchema.optional(),
  occurred_at: isoDatetimeSchema.optional()
});

export const protocolErrorCatalog: Readonly<Record<ProtocolErrorCode, string>> = {
  UNAUTHORIZED: "Authentication is required or token is invalid.",
  FORBIDDEN: "Caller is authenticated but not authorized for this operation.",
  INVALID_ARGUMENT: "Request payload failed validation.",
  NOT_FOUND: "Requested resource was not found.",
  CONFLICT: "Operation conflicts with current resource state.",
  WORKSPACE_MISMATCH: "Caller workspace does not match resource workspace.",
  INVALID_THREAD_TRANSITION: "Thread status transition is not allowed.",
  IDEMPOTENCY_CONFLICT: "Idempotency key is already associated with a conflicting request.",
  RATE_LIMITED: "Request exceeded allowed rate limits.",
  INTERNAL: "Unexpected internal error."
};
