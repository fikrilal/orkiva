import { AuthError } from "./errors.js";
import type { AuthRole } from "./claims.js";

export const rolePermissions = {
  participant: {
    canReadThread: true,
    canWriteMessage: true,
    canManageThread: false,
    canReadAudit: false
  },
  coordinator: {
    canReadThread: true,
    canWriteMessage: true,
    canManageThread: true,
    canReadAudit: true
  },
  auditor: {
    canReadThread: true,
    canWriteMessage: false,
    canManageThread: false,
    canReadAudit: true
  }
} as const;

export type AuthOperation =
  | "thread:read"
  | "thread:manage"
  | "message:read"
  | "message:write"
  | "session:heartbeat"
  | "audit:read";

const operationAllowedRoles: Readonly<Record<AuthOperation, readonly AuthRole[]>> = {
  "thread:read": ["participant", "coordinator", "auditor"],
  "thread:manage": ["coordinator"],
  "message:read": ["participant", "coordinator", "auditor"],
  "message:write": ["participant", "coordinator"],
  "session:heartbeat": ["participant", "coordinator", "auditor"],
  "audit:read": ["coordinator", "auditor"]
};

export const isRoleAllowed = (role: AuthRole, allowedRoles: readonly AuthRole[]): boolean =>
  allowedRoles.includes(role);

export const assertRoleAllowed = (
  role: AuthRole,
  allowedRoles: readonly AuthRole[],
  operation?: string
): void => {
  if (isRoleAllowed(role, allowedRoles)) {
    return;
  }

  throw new AuthError(
    "FORBIDDEN",
    `Role "${role}" is not allowed for operation "${operation ?? "unknown"}"`,
    {
      role,
      allowedRoles,
      operation
    }
  );
};

export const authorizeOperation = (role: AuthRole, operation: AuthOperation): void => {
  assertRoleAllowed(role, operationAllowedRoles[operation], operation);
};
