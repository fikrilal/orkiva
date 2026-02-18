import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  AuthError,
  assertPayloadIdentityMatchesClaims,
  assertWorkspaceBoundary,
  authorizeOperation,
  type VerifiedAuthClaims
} from "@orkiva/auth";
import {
  DomainError,
  acknowledgeRead,
  createParticipantCursor,
  getNextMessageSequence,
  type ThreadStatus
} from "@orkiva/domain";
import {
  ackReadInputSchema,
  ackReadOutputSchema,
  createThreadInputSchema,
  createThreadOutputSchema,
  getThreadInputSchema,
  getThreadOutputSchema,
  postMessageInputSchema,
  postMessageOutputSchema,
  protocolErrorResponseSchema,
  readMessagesInputSchema,
  readMessagesOutputSchema,
  summarizeThreadInputSchema,
  summarizeThreadOutputSchema,
  updateThreadStatusInputSchema,
  updateThreadStatusOutputSchema,
  type ProtocolErrorCode
} from "@orkiva/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { AuditEventInput, AuditStore } from "./audit-store.js";
import type { MessageRecord, ThreadStore } from "./thread-store.js";

type MCPMethodName =
  | "create_thread"
  | "get_thread"
  | "update_thread_status"
  | "summarize_thread"
  | "post_message"
  | "read_messages"
  | "ack_read";

export interface BridgeApiRequestContext {
  requestId: string;
  authClaims: VerifiedAuthClaims;
}

declare module "fastify" {
  interface FastifyRequest {
    context?: BridgeApiRequestContext;
  }
}

export interface BridgeApiAppDependencies {
  threadStore: ThreadStore;
  auditStore?: AuditStore;
  verifyAccessToken: (token: string) => Promise<VerifiedAuthClaims>;
  now?: () => Date;
  idGenerator?: () => string;
}

class BridgeApiError extends Error {
  public readonly code: ProtocolErrorCode;
  public readonly statusCode: number;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(
    code: ProtocolErrorCode,
    statusCode: number,
    message: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "BridgeApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const parseBearerToken = (authorizationHeader: string | undefined): string => {
  if (!authorizationHeader) {
    throw new AuthError("UNAUTHORIZED", "Missing Authorization header");
  }

  const [scheme, token] = authorizationHeader.split(" ", 2);
  if (scheme !== "Bearer" || !token || token.trim().length === 0) {
    throw new AuthError("UNAUTHORIZED", "Authorization header must be in Bearer format");
  }

  return token;
};

const requireContext = (request: FastifyRequest): BridgeApiRequestContext => {
  if (!request.context) {
    throw new BridgeApiError("UNAUTHORIZED", 401, "Missing authenticated request context");
  }

  return request.context;
};

const mapAuthError = (error: AuthError): BridgeApiError => {
  switch (error.code) {
    case "UNAUTHORIZED":
    case "INVALID_CLAIMS":
      return new BridgeApiError("UNAUTHORIZED", 401, error.message, error.context);
    case "FORBIDDEN":
      return new BridgeApiError("FORBIDDEN", 403, error.message, error.context);
    case "WORKSPACE_MISMATCH":
      return new BridgeApiError("WORKSPACE_MISMATCH", 403, error.message, error.context);
    case "CLAIM_MISMATCH":
      return new BridgeApiError("FORBIDDEN", 403, error.message, error.context);
    case "INVALID_ARGUMENT":
      return new BridgeApiError("INVALID_ARGUMENT", 400, error.message, error.context);
    default:
      return new BridgeApiError("INTERNAL", 500, "Unhandled auth error");
  }
};

const mapDomainError = (error: DomainError): BridgeApiError => {
  switch (error.code) {
    case "INVALID_THREAD_TRANSITION":
      return new BridgeApiError("INVALID_THREAD_TRANSITION", 409, error.message, error.context);
    case "INVALID_ARGUMENT":
      return new BridgeApiError("INVALID_ARGUMENT", 400, error.message, error.context);
    case "SEQUENCE_VIOLATION":
    case "SEQUENCE_OVERFLOW":
    case "CURSOR_REGRESSION":
    case "SESSION_SCOPE_MISMATCH":
      return new BridgeApiError("CONFLICT", 409, error.message, error.context);
    default:
      return new BridgeApiError("INTERNAL", 500, "Unhandled domain error");
  }
};

const hasIssuesArray = (value: unknown): value is { issues: unknown[] } =>
  typeof value === "object" &&
  value !== null &&
  "issues" in value &&
  Array.isArray((value as { issues?: unknown }).issues);

const hasDatabaseErrorCode = (
  value: unknown
): value is { code: string; constraint?: string; detail?: string } =>
  typeof value === "object" &&
  value !== null &&
  "code" in value &&
  typeof (value as { code?: unknown }).code === "string";

const mapUnknownError = (error: unknown): BridgeApiError => {
  if (error instanceof BridgeApiError) {
    return error;
  }

  if (error instanceof AuthError) {
    return mapAuthError(error);
  }

  if (error instanceof DomainError) {
    return mapDomainError(error);
  }

  if (hasIssuesArray(error)) {
    return new BridgeApiError("INVALID_ARGUMENT", 400, "Payload validation failed", {
      issues: error.issues
    });
  }

  if (hasDatabaseErrorCode(error)) {
    if (error.code === "23505" || error.code === "40001") {
      return new BridgeApiError("CONFLICT", 409, "Write conflict", {
        code: error.code,
        ...(error.constraint === undefined ? {} : { constraint: error.constraint }),
        ...(error.detail === undefined ? {} : { detail: error.detail })
      });
    }
  }

  return new BridgeApiError(
    "INTERNAL",
    500,
    error instanceof Error ? error.message : "Internal server error"
  );
};

const toIso = (value: Date): string => value.toISOString();
const POST_MESSAGE_MAX_ATTEMPTS = 3;
const OVERRIDE_REASON_PREFIXES = ["human_override:", "coordinator_override:"] as const;

const hasExplicitOverrideReason = (value: string): boolean =>
  OVERRIDE_REASON_PREFIXES.some((prefix) => value.startsWith(prefix));

const isIdempotentReplayMatch = (input: {
  schemaVersion: number;
  kind: MessageRecord["kind"];
  body: string;
  metadata?: Record<string, unknown>;
  inReplyTo?: string;
}): ((existing: MessageRecord) => boolean) => {
  const normalizedMetadata = input.metadata ?? undefined;
  const normalizedInReplyTo = input.inReplyTo ?? undefined;

  return (existing) =>
    existing.schemaVersion === input.schemaVersion &&
    existing.kind === input.kind &&
    existing.body === input.body &&
    isDeepStrictEqual(existing.metadata ?? undefined, normalizedMetadata) &&
    (existing.inReplyTo ?? undefined) === normalizedInReplyTo;
};

const toPostMessageOutput = (
  message: MessageRecord,
  threadStatus: ThreadStatus
): ReturnType<typeof postMessageOutputSchema.parse> =>
  postMessageOutputSchema.parse({
    message_id: message.messageId,
    seq: message.seq,
    thread_status: threadStatus,
    created_at: toIso(message.createdAt)
  });

const extractThreadIdFromBody = (request: FastifyRequest): string | undefined => {
  const body = request.body;
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const threadId = (body as Record<string, unknown>)["thread_id"];
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
};

const extractWorkspaceIdFromBody = (request: FastifyRequest): string | undefined => {
  const body = request.body;
  if (typeof body !== "object" || body === null) {
    return undefined;
  }

  const workspaceId = (body as Record<string, unknown>)["workspace_id"];
  return typeof workspaceId === "string" && workspaceId.trim().length > 0 ? workspaceId : undefined;
};

const deriveOperationName = (request: FastifyRequest): string => {
  if (request.url.startsWith("/v1/mcp/")) {
    const params = request.params as { method?: unknown };
    if (typeof params.method === "string" && params.method.trim().length > 0) {
      return `mcp.${params.method}`;
    }
  }

  return `${request.method} ${request.url}`;
};

const threadRecordToProtocol = (record: {
  threadId: string;
  workspaceId: string;
  title: string;
  type: "conversation" | "workflow" | "incident";
  status: ThreadStatus;
  participants: readonly string[];
  createdAt: Date;
  updatedAt: Date;
}): ReturnType<typeof getThreadOutputSchema.parse> =>
  getThreadOutputSchema.parse({
    thread_id: record.threadId,
    workspace_id: record.workspaceId,
    title: record.title,
    type: record.type,
    status: record.status,
    participants: [...record.participants],
    created_at: toIso(record.createdAt),
    updated_at: toIso(record.updatedAt)
  });

export const createBridgeApiApp = (dependencies: BridgeApiAppDependencies): FastifyInstance => {
  const now = dependencies.now ?? (() => new Date());
  const idGenerator = dependencies.idGenerator ?? randomUUID;
  const writeAuditEvent = async (input: AuditEventInput): Promise<void> => {
    if (!dependencies.auditStore) {
      return;
    }

    try {
      await dependencies.auditStore.writeEvent(input);
    } catch {
      // Audit write failures should not fail request path.
    }
  };

  const app = Fastify({
    logger: false,
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      if (typeof header === "string" && header.trim().length > 0) {
        return header;
      }

      if (Array.isArray(header) && header.length > 0) {
        const [firstHeader] = header;
        if (firstHeader && firstHeader.trim().length > 0) {
          return firstHeader;
        }
      }

      return randomUUID();
    }
  });

  app.addHook("onRequest", async (request) => {
    if (!request.url.startsWith("/v1/")) {
      return;
    }

    const token = parseBearerToken(request.headers.authorization);
    const claims = await dependencies.verifyAccessToken(token);
    request.context = {
      requestId: request.id,
      authClaims: claims
    };
  });

  app.addHook("preHandler", async (request, reply) => {
    reply.header("x-request-id", request.id);
  });

  app.setErrorHandler(async (error, request, reply) => {
    const mapped = mapUnknownError(error);
    if (mapped.statusCode === 401 || mapped.statusCode === 403) {
      const threadId = extractThreadIdFromBody(request);
      const context = request.context;
      await writeAuditEvent({
        workspaceId: context?.authClaims.workspaceId ?? extractWorkspaceIdFromBody(request) ?? "unknown",
        ...(context === undefined ? {} : { actorAgentId: context.authClaims.agentId }),
        ...(context === undefined ? {} : { actorRole: context.authClaims.role }),
        operation: deriveOperationName(request),
        resourceType: threadId === undefined ? "request" : "thread",
        resourceId: threadId ?? request.url,
        ...(threadId === undefined ? {} : { threadId }),
        requestId: request.id,
        result: "rejected",
        payload: {
          error_code: mapped.code,
          message: mapped.message
        },
        createdAt: now()
      });
    }

    const payload = protocolErrorResponseSchema.parse({
      error: {
        code: mapped.code,
        message: mapped.message,
        details: mapped.details
      },
      request_id: request.id,
      occurred_at: now().toISOString()
    });

    void reply.status(mapped.statusCode).send(payload);
  });

  app.get("/health", () => ({
    ok: true,
    service: "bridge-api",
    now: now().toISOString()
  }));

  const methodHandlers: Record<
    MCPMethodName,
    (payload: unknown, request: FastifyRequest) => Promise<unknown>
  > = {
    create_thread: async (payload, request) => {
      const input = createThreadInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      authorizeOperation(authClaims.role, "thread:manage");
      assertWorkspaceBoundary(authClaims, input.workspace_id);

      if (input.created_by !== undefined) {
        assertPayloadIdentityMatchesClaims(authClaims, { agent_id: input.created_by });
      }

      const createdAt = now();
      const created = await dependencies.threadStore.createThread({
        threadId: `th_${idGenerator()}`,
        workspaceId: input.workspace_id,
        title: input.title,
        type: input.type,
        participants: input.participants,
        createdAt
      });

      return createThreadOutputSchema.parse({
        thread_id: created.threadId,
        status: created.status,
        created_at: toIso(created.createdAt)
      });
    },
    get_thread: async (payload, request) => {
      const input = getThreadInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      authorizeOperation(authClaims.role, "thread:read");
      const existing = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existing) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existing.workspaceId);
      return threadRecordToProtocol(existing);
    },
    update_thread_status: async (payload, request) => {
      const input = updateThreadStatusInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      if (authClaims.role === "participant" && input.status === "closed") {
        throw new BridgeApiError(
          "FORBIDDEN",
          403,
          "Worker role cannot force-close disputed threads",
          {
            role: authClaims.role,
            requested_status: input.status
          }
        );
      }

      authorizeOperation(authClaims.role, "thread:manage");
      if (input.agent_id !== undefined) {
        assertPayloadIdentityMatchesClaims(authClaims, { agent_id: input.agent_id });
      }

      const existing = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existing) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existing.workspaceId);
      const isDisputedClose = existing.status === "blocked" && input.status === "closed";
      if (isDisputedClose && !hasExplicitOverrideReason(input.reason)) {
        throw new BridgeApiError(
          "FORBIDDEN",
          403,
          "Closing a blocked thread requires explicit coordinator/human override reason",
          {
            required_reason_prefixes: [...OVERRIDE_REASON_PREFIXES],
            reason: input.reason,
            current_status: existing.status,
            requested_status: input.status
          }
        );
      }

      const updated = await dependencies.threadStore.updateThreadStatus(
        input.thread_id,
        input.status,
        now(),
        {
          expectedCurrentStatus: existing.status
        }
      );
      if (!updated) {
        const latest = await dependencies.threadStore.getThreadById(input.thread_id);
        if (!latest) {
          throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
        }

        throw new BridgeApiError("CONFLICT", 409, "Thread status changed by a concurrent update", {
          thread_id: input.thread_id,
          expected_status: existing.status,
          current_status: latest.status
        });
      }

      await writeAuditEvent({
        workspaceId: authClaims.workspaceId,
        actorAgentId: authClaims.agentId,
        actorRole: authClaims.role,
        operation: "mcp.update_thread_status",
        resourceType: "thread",
        resourceId: updated.threadId,
        threadId: updated.threadId,
        requestId: request.id,
        result: "success",
        payload: {
          from_status: existing.status,
          to_status: updated.status,
          reason: input.reason,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata })
        },
        createdAt: now()
      });

      return updateThreadStatusOutputSchema.parse({
        thread_id: updated.threadId,
        status: updated.status,
        updated_at: toIso(updated.updatedAt)
      });
    },
    summarize_thread: async (payload, request) => {
      const input = summarizeThreadInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      authorizeOperation(authClaims.role, "thread:read");
      const existing = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existing) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existing.workspaceId);
      const summary = await dependencies.threadStore.summarizeThread(
        input.thread_id,
        input.max_messages
      );
      if (!summary) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      return summarizeThreadOutputSchema.parse({
        summary: summary.summary,
        open_items: summary.openItems,
        last_status: summary.lastStatus
      });
    },
    post_message: async (payload, request) => {
      const input = postMessageInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      authorizeOperation(authClaims.role, "message:write");
      assertPayloadIdentityMatchesClaims(authClaims, {
        ...(input.sender_agent_id === undefined ? {} : { agent_id: input.sender_agent_id }),
        ...(input.sender_session_id === undefined ? {} : { session_id: input.sender_session_id })
      });

      const existingThread = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existingThread) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existingThread.workspaceId);

      if (input.in_reply_to !== undefined) {
        const parentMessage = await dependencies.threadStore.getMessageById(
          input.thread_id,
          input.in_reply_to
        );
        if (!parentMessage) {
          throw new BridgeApiError(
            "INVALID_ARGUMENT",
            400,
            `"in_reply_to" does not reference a message in this thread`,
            {
              thread_id: input.thread_id,
              in_reply_to: input.in_reply_to
            }
          );
        }
      }

      if (input.idempotency_key !== undefined) {
        const existingMessage = await dependencies.threadStore.getMessageByIdempotency(
          input.thread_id,
          authClaims.agentId,
          input.idempotency_key
        );
        if (existingMessage) {
          const replayMatcher = isIdempotentReplayMatch({
            schemaVersion: input.schema_version,
            kind: input.kind,
            body: input.body,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            ...(input.in_reply_to === undefined ? {} : { inReplyTo: input.in_reply_to })
          });
          if (!replayMatcher(existingMessage)) {
            throw new BridgeApiError(
              "IDEMPOTENCY_CONFLICT",
              409,
              "Idempotency key is already used with a different payload",
              {
                thread_id: input.thread_id,
                sender_agent_id: authClaims.agentId,
                idempotency_key: input.idempotency_key
              }
            );
          }

          return toPostMessageOutput(existingMessage, existingThread.status);
        }
      }

      for (let attempt = 1; attempt <= POST_MESSAGE_MAX_ATTEMPTS; attempt += 1) {
        const latestSeq = await dependencies.threadStore.getLatestMessageSeq(input.thread_id);
        const nextSeq = getNextMessageSequence(latestSeq);

        try {
          const created = await dependencies.threadStore.createMessage({
            messageId: `msg_${idGenerator()}`,
            threadId: input.thread_id,
            schemaVersion: input.schema_version,
            seq: nextSeq,
            senderAgentId: authClaims.agentId,
            senderSessionId: authClaims.sessionId,
            kind: input.kind,
            body: input.body,
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
            ...(input.in_reply_to === undefined ? {} : { inReplyTo: input.in_reply_to }),
            ...(input.idempotency_key === undefined
              ? {}
              : { idempotencyKey: input.idempotency_key }),
            createdAt: now()
          });

          return toPostMessageOutput(created, existingThread.status);
        } catch (error) {
          if (input.idempotency_key !== undefined) {
            const concurrentMessage = await dependencies.threadStore.getMessageByIdempotency(
              input.thread_id,
              authClaims.agentId,
              input.idempotency_key
            );
            if (concurrentMessage) {
              const replayMatcher = isIdempotentReplayMatch({
                schemaVersion: input.schema_version,
                kind: input.kind,
                body: input.body,
                ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
                ...(input.in_reply_to === undefined ? {} : { inReplyTo: input.in_reply_to })
              });

              if (!replayMatcher(concurrentMessage)) {
                throw new BridgeApiError(
                  "IDEMPOTENCY_CONFLICT",
                  409,
                  "Idempotency key is already used with a different payload",
                  {
                    thread_id: input.thread_id,
                    sender_agent_id: authClaims.agentId,
                    idempotency_key: input.idempotency_key
                  }
                );
              }

              return toPostMessageOutput(concurrentMessage, existingThread.status);
            }
          }

          const mapped = mapUnknownError(error);
          if (mapped.code === "CONFLICT" && attempt < POST_MESSAGE_MAX_ATTEMPTS) {
            continue;
          }

          throw error;
        }
      }

      throw new BridgeApiError("CONFLICT", 409, "Unable to persist message after bounded retries", {
        thread_id: input.thread_id,
        max_attempts: POST_MESSAGE_MAX_ATTEMPTS
      });
    },
    read_messages: async (payload, request) => {
      const input = readMessagesInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      authorizeOperation(authClaims.role, "message:read");
      if (input.agent_id !== undefined) {
        assertPayloadIdentityMatchesClaims(authClaims, { agent_id: input.agent_id });
      }

      const existingThread = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existingThread) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existingThread.workspaceId);
      const page = await dependencies.threadStore.readMessages(
        input.thread_id,
        input.since_seq,
        input.limit
      );

      return readMessagesOutputSchema.parse({
        messages: page.messages.map((message) => ({
          message_id: message.messageId,
          schema_version: message.schemaVersion,
          seq: message.seq,
          kind: message.kind,
          body: message.body,
          ...(message.metadata === undefined ? {} : { metadata: message.metadata }),
          sender_agent_id: message.senderAgentId,
          created_at: toIso(message.createdAt)
        })),
        next_seq: page.nextSeq,
        has_more: page.hasMore
      });
    },
    ack_read: async (payload, request) => {
      const input = ackReadInputSchema.parse(payload);
      const { authClaims } = requireContext(request);

      authorizeOperation(authClaims.role, "message:read");
      if (input.agent_id !== undefined) {
        assertPayloadIdentityMatchesClaims(authClaims, { agent_id: input.agent_id });
      }

      const existingThread = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existingThread) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existingThread.workspaceId);
      const latestSeq = await dependencies.threadStore.getLatestMessageSeq(input.thread_id);
      if (input.last_read_seq > latestSeq) {
        throw new BridgeApiError(
          "INVALID_ARGUMENT",
          400,
          `"last_read_seq" cannot exceed latest thread sequence`,
          {
            thread_id: input.thread_id,
            last_read_seq: input.last_read_seq,
            latest_seq: latestSeq
          }
        );
      }

      const cursor =
        (await dependencies.threadStore.getParticipantCursor(
          input.thread_id,
          authClaims.agentId
        )) ??
        createParticipantCursor({
          threadId: input.thread_id,
          agentId: authClaims.agentId,
          createdAt: now()
        });
      const updatedCursor = acknowledgeRead(cursor, {
        lastReadSeq: input.last_read_seq,
        updatedAt: now()
      });
      await dependencies.threadStore.upsertParticipantCursor(updatedCursor);

      return ackReadOutputSchema.parse({
        ok: true,
        updated_at: toIso(updatedCursor.updatedAt)
      });
    }
  };

  app.post<{ Params: { method: string } }>("/v1/mcp/:method", async (request, reply) => {
    const method = request.params.method as MCPMethodName;
    const handler = methodHandlers[method];
    if (!handler) {
      throw new BridgeApiError("NOT_FOUND", 404, `Unknown MCP method: ${request.params.method}`);
    }

    const payload = await handler(request.body, request);
    await reply.send(payload);
  });

  return app;
};

export const _bridgeApiInternals = {
  parseBearerToken
};
