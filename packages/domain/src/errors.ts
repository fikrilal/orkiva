export type DomainErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_THREAD_TRANSITION"
  | "SEQUENCE_VIOLATION"
  | "SEQUENCE_OVERFLOW"
  | "CURSOR_REGRESSION"
  | "SESSION_SCOPE_MISMATCH";

export type DomainErrorContext = Readonly<Record<string, unknown>>;

export class DomainError extends Error {
  public readonly code: DomainErrorCode;
  public readonly context: DomainErrorContext | undefined;

  public constructor(code: DomainErrorCode, message: string, context?: DomainErrorContext) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.context = context;
  }
}

const ensureValidDate = (value: Date, fieldName: string): Date => {
  if (Number.isNaN(value.getTime())) {
    throw new DomainError("INVALID_ARGUMENT", `"${fieldName}" must be a valid date`, {
      fieldName
    });
  }

  return value;
};

export const requireDate = (value: Date, fieldName: string): Date =>
  ensureValidDate(value, fieldName);

export const requireNonEmptyString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new DomainError("INVALID_ARGUMENT", `"${fieldName}" must be a non-empty string`, {
      fieldName
    });
  }

  return normalized;
};

export const requireNonNegativeInteger = (value: number, fieldName: string): number => {
  if (!Number.isInteger(value) || value < 0) {
    throw new DomainError("INVALID_ARGUMENT", `"${fieldName}" must be a non-negative integer`, {
      fieldName,
      value
    });
  }

  return value;
};

export const requirePositiveInteger = (value: number, fieldName: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new DomainError("INVALID_ARGUMENT", `"${fieldName}" must be a positive integer`, {
      fieldName,
      value
    });
  }

  return value;
};
