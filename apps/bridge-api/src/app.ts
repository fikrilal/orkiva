import { randomUUID } from "node:crypto";

import {
  AuthError,
  assertPayloadIdentityMatchesClaims,
  assertWorkspaceBoundary,
  authorizeOperation,
  type VerifiedAuthClaims
} from "@orkiva/auth";
import { DomainError, type ThreadStatus } from "@orkiva/domain";
import {
  createThreadInputSchema,
  createThreadOutputSchema,
  getThreadInputSchema,
  getThreadOutputSchema,
  protocolErrorResponseSchema,
  summarizeThreadInputSchema,
  summarizeThreadOutputSchema,
  updateThreadStatusInputSchema,
  updateThreadStatusOutputSchema,
  type ProtocolErrorCode
} from "@orkiva/protocol";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import type { ThreadStore } from "./thread-store.js";

type MCPMethodName = "create_thread" | "get_thread" | "update_thread_status" | "summarize_thread";

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

  return new BridgeApiError(
    "INTERNAL",
    500,
    error instanceof Error ? error.message : "Internal server error"
  );
};

const toIso = (value: Date): string => value.toISOString();

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

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapUnknownError(error);
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

      authorizeOperation(authClaims.role, "thread:manage");
      if (input.agent_id !== undefined) {
        assertPayloadIdentityMatchesClaims(authClaims, { agent_id: input.agent_id });
      }

      const existing = await dependencies.threadStore.getThreadById(input.thread_id);
      if (!existing) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

      assertWorkspaceBoundary(authClaims, existing.workspaceId);

      const updated = await dependencies.threadStore.updateThreadStatus(
        input.thread_id,
        input.status,
        now()
      );
      if (!updated) {
        throw new BridgeApiError("NOT_FOUND", 404, `Thread not found: ${input.thread_id}`);
      }

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
