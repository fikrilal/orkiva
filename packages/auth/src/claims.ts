import type { JWTPayload } from "jose";

import { AuthError } from "./errors.js";

export const authRoles = ["participant", "coordinator", "auditor"] as const;
export type AuthRole = (typeof authRoles)[number];

export interface VerifiedAuthClaims {
  agentId: string;
  workspaceId: string;
  role: AuthRole;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
  jwtId: string;
  raw: JWTPayload;
}

const roleSet: ReadonlySet<AuthRole> = new Set(authRoles);

const requireStringClaim = (payload: JWTPayload, claim: string): string => {
  const value = payload[claim];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AuthError("INVALID_CLAIMS", `Missing or invalid required claim "${claim}"`, {
      claim
    });
  }

  return value;
};

const requireNumericClaim = (
  payload: JWTPayload,
  claim: "iat" | "exp",
  minimumValue: number
): number => {
  const value = payload[claim];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new AuthError("INVALID_CLAIMS", `Missing or invalid required claim "${claim}"`, {
      claim
    });
  }

  if (value < minimumValue) {
    throw new AuthError("INVALID_CLAIMS", `Claim "${claim}" must be >= ${minimumValue}`, {
      claim,
      value,
      minimumValue
    });
  }

  return value;
};

const requireRoleClaim = (payload: JWTPayload): AuthRole => {
  const role = requireStringClaim(payload, "role");
  if (!roleSet.has(role as AuthRole)) {
    throw new AuthError("INVALID_CLAIMS", `Unsupported role "${role}"`, {
      role
    });
  }

  return role as AuthRole;
};

export const mapVerifiedClaims = (payload: JWTPayload): VerifiedAuthClaims => ({
  agentId: requireStringClaim(payload, "agent_id"),
  workspaceId: requireStringClaim(payload, "workspace_id"),
  role: requireRoleClaim(payload),
  sessionId: requireStringClaim(payload, "session_id"),
  jwtId: requireStringClaim(payload, "jti"),
  issuedAt: requireNumericClaim(payload, "iat", 1),
  expiresAt: requireNumericClaim(payload, "exp", 1),
  raw: payload
});

export interface PayloadIdentityHints {
  agent_id?: string;
  workspace_id?: string;
  role?: string;
  session_id?: string;
}

const assertHintMatch = (
  hintName: keyof PayloadIdentityHints,
  hintValue: string | undefined,
  claimValue: string
): void => {
  if (hintValue === undefined) {
    return;
  }

  if (hintValue !== claimValue) {
    throw new AuthError("CLAIM_MISMATCH", `Payload identity mismatch on "${hintName}"`, {
      hintName,
      payloadValue: hintValue,
      claimValue
    });
  }
};

export const assertPayloadIdentityMatchesClaims = (
  claims: VerifiedAuthClaims,
  hints: PayloadIdentityHints
): void => {
  assertHintMatch("agent_id", hints.agent_id, claims.agentId);
  assertHintMatch("workspace_id", hints.workspace_id, claims.workspaceId);
  assertHintMatch("role", hints.role, claims.role);
  assertHintMatch("session_id", hints.session_id, claims.sessionId);
};

export const assertWorkspaceBoundary = (
  claims: VerifiedAuthClaims,
  targetWorkspaceId: string
): void => {
  if (targetWorkspaceId.trim().length === 0) {
    throw new AuthError("INVALID_ARGUMENT", '"targetWorkspaceId" must be a non-empty string');
  }

  if (claims.workspaceId !== targetWorkspaceId) {
    throw new AuthError(
      "WORKSPACE_MISMATCH",
      `Workspace mismatch: token=${claims.workspaceId} request=${targetWorkspaceId}`,
      {
        tokenWorkspaceId: claims.workspaceId,
        requestWorkspaceId: targetWorkspaceId
      }
    );
  }
};
