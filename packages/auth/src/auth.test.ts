import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  AuthError,
  assertPayloadIdentityMatchesClaims,
  assertWorkspaceBoundary,
  authorizeOperation,
  verifyAccessToken
} from "./index.js";

const issuer = "https://issuer.orkiva.local";
const audience = "orkiva";

type SigningKey = Parameters<SignJWT["sign"]>[0];

let primaryPrivateKey: SigningKey | undefined;
let localJwksResolver: ReturnType<typeof createLocalJWKSet>;

const buildToken = async (
  payload: JWTPayload,
  options?: {
    iat?: number;
    exp?: number;
    jti?: string;
    key?: SigningKey;
  }
): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const signer = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-kid", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt(options?.iat ?? now)
    .setExpirationTime(options?.exp ?? now + 300);

  if (options?.jti !== undefined) {
    signer.setJti(options.jti);
  } else {
    signer.setJti("jti-default");
  }

  const signingKey = options?.key ?? primaryPrivateKey;
  if (!signingKey) {
    throw new Error("Signing key has not been initialized");
  }

  return signer.sign(signingKey);
};

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  primaryPrivateKey = privateKey;

  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid";
  jwk.use = "sig";
  jwk.alg = "RS256";
  localJwksResolver = createLocalJWKSet({ keys: [jwk] });
});

describe("auth verifier", () => {
  it("verifies valid token and maps required claims", async () => {
    const token = await buildToken({
      agent_id: "agent_exec",
      workspace_id: "wk_01",
      role: "participant",
      session_id: "sess_01"
    });

    const claims = await verifyAccessToken(token, {
      issuer,
      audience,
      keyResolver: localJwksResolver
    });

    expect(claims.agentId).toBe("agent_exec");
    expect(claims.workspaceId).toBe("wk_01");
    expect(claims.role).toBe("participant");
    expect(claims.sessionId).toBe("sess_01");
    expect(claims.jwtId).toBe("jti-default");
    expect(claims.issuedAt).toBeGreaterThan(0);
    expect(claims.expiresAt).toBeGreaterThan(claims.issuedAt);
  });

  it("rejects expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await buildToken(
      {
        agent_id: "agent_exec",
        workspace_id: "wk_01",
        role: "participant",
        session_id: "sess_01"
      },
      {
        iat: now - 120,
        exp: now - 60
      }
    );

    await expect(
      verifyAccessToken(token, {
        issuer,
        audience,
        keyResolver: localJwksResolver
      })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
  });

  it("rejects token with invalid signature", async () => {
    const { privateKey } = await generateKeyPair("RS256");
    const token = await buildToken(
      {
        agent_id: "agent_exec",
        workspace_id: "wk_01",
        role: "participant",
        session_id: "sess_01"
      },
      {
        key: privateKey
      }
    );

    await expect(
      verifyAccessToken(token, {
        issuer,
        audience,
        keyResolver: localJwksResolver
      })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
  });

  it("rejects token with missing required claims", async () => {
    const token = await buildToken({
      workspace_id: "wk_01",
      role: "participant",
      session_id: "sess_01"
    });

    await expect(
      verifyAccessToken(token, {
        issuer,
        audience,
        keyResolver: localJwksResolver
      })
    ).rejects.toMatchObject({
      code: "INVALID_CLAIMS"
    });
  });

  it("rejects token with unsupported role claim", async () => {
    const token = await buildToken({
      agent_id: "agent_exec",
      workspace_id: "wk_01",
      role: "worker",
      session_id: "sess_01"
    });

    await expect(
      verifyAccessToken(token, {
        issuer,
        audience,
        keyResolver: localJwksResolver
      })
    ).rejects.toMatchObject({
      code: "INVALID_CLAIMS"
    });
  });
});

describe("auth guards", () => {
  it("rejects payload identity mismatch", async () => {
    const token = await buildToken({
      agent_id: "agent_exec",
      workspace_id: "wk_01",
      role: "participant",
      session_id: "sess_01"
    });

    const claims = await verifyAccessToken(token, {
      issuer,
      audience,
      keyResolver: localJwksResolver
    });

    expect(() =>
      assertPayloadIdentityMatchesClaims(claims, {
        agent_id: "agent_other"
      })
    ).toThrow(AuthError);
  });

  it("rejects cross-workspace access", async () => {
    const token = await buildToken({
      agent_id: "agent_exec",
      workspace_id: "wk_01",
      role: "participant",
      session_id: "sess_01"
    });

    const claims = await verifyAccessToken(token, {
      issuer,
      audience,
      keyResolver: localJwksResolver
    });

    expect(() => assertWorkspaceBoundary(claims, "wk_other")).toThrow(AuthError);
  });

  it("enforces role authorization policies", () => {
    expect(() => authorizeOperation("participant", "message:write")).not.toThrow();
    expect(() => authorizeOperation("auditor", "message:write")).toThrow(AuthError);
    expect(() => authorizeOperation("coordinator", "thread:manage")).not.toThrow();
  });
});
