import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

import { mapVerifiedClaims, type VerifiedAuthClaims } from "./claims.js";
import { AuthError } from "./errors.js";

const requireNonEmptyString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AuthError("INVALID_ARGUMENT", `"${fieldName}" must be a non-empty string`, {
      fieldName
    });
  }

  return normalized;
};

export interface AccessTokenVerifierOptions {
  issuer: string;
  audience: string;
  jwksUrl?: string;
  keyResolver?: JWTVerifyGetKey;
  clockToleranceSeconds?: number;
}

export interface ResolvedVerifierOptions {
  issuer: string;
  audience: string;
  keyResolver: JWTVerifyGetKey;
  clockToleranceSeconds?: number;
}

const resolveVerifierOptions = (options: AccessTokenVerifierOptions): ResolvedVerifierOptions => {
  const issuer = requireNonEmptyString(options.issuer, "issuer");
  const audience = requireNonEmptyString(options.audience, "audience");

  if (options.keyResolver) {
    return {
      issuer,
      audience,
      keyResolver: options.keyResolver,
      ...(options.clockToleranceSeconds === undefined
        ? {}
        : { clockToleranceSeconds: options.clockToleranceSeconds })
    };
  }

  const jwksUrl = options.jwksUrl ? requireNonEmptyString(options.jwksUrl, "jwksUrl") : undefined;
  if (!jwksUrl) {
    throw new AuthError("INVALID_ARGUMENT", "Either keyResolver or jwksUrl must be provided");
  }

  return {
    issuer,
    audience,
    keyResolver: createRemoteJWKSet(new URL(jwksUrl)),
    ...(options.clockToleranceSeconds === undefined
      ? {}
      : { clockToleranceSeconds: options.clockToleranceSeconds })
  };
};

export const verifyAccessToken = async (
  token: string,
  options: AccessTokenVerifierOptions
): Promise<VerifiedAuthClaims> => {
  const normalizedToken = requireNonEmptyString(token, "token");
  const resolved = resolveVerifierOptions(options);

  try {
    const { payload } = await jwtVerify(normalizedToken, resolved.keyResolver, {
      issuer: resolved.issuer,
      audience: resolved.audience,
      clockTolerance: resolved.clockToleranceSeconds ?? 0
    });

    return mapVerifiedClaims(payload);
  } catch (error) {
    if (error instanceof AuthError) {
      throw error;
    }

    throw new AuthError("UNAUTHORIZED", "Access token verification failed", {
      reason: error instanceof Error ? error.message : String(error)
    });
  }
};

export const createAccessTokenVerifier = (
  options: AccessTokenVerifierOptions
): ((token: string) => Promise<VerifiedAuthClaims>) => {
  const resolved = resolveVerifierOptions(options);

  return async (token: string): Promise<VerifiedAuthClaims> =>
    verifyAccessToken(token, {
      issuer: resolved.issuer,
      audience: resolved.audience,
      keyResolver: resolved.keyResolver,
      ...(resolved.clockToleranceSeconds === undefined
        ? {}
        : { clockToleranceSeconds: resolved.clockToleranceSeconds })
    });
};
