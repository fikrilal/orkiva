export type AuthErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_ARGUMENT"
  | "INVALID_CLAIMS"
  | "CLAIM_MISMATCH"
  | "WORKSPACE_MISMATCH";

export type AuthErrorContext = Readonly<Record<string, unknown>>;

export class AuthError extends Error {
  public readonly code: AuthErrorCode;
  public readonly context: AuthErrorContext | undefined;

  public constructor(code: AuthErrorCode, message: string, context?: AuthErrorContext) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.context = context;
  }
}
