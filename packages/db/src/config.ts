import { z } from "zod";

const positiveIntWithDefault = (value: number) =>
  z
    .string()
    .optional()
    .default(String(value))
    .transform((raw) => Number(raw))
    .pipe(z.number().int().positive());

const dbRuntimeConfigSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    .optional()
    .default("postgres://postgres:postgres@localhost:54322/orkiva"),
  DB_READY_MAX_ATTEMPTS: positiveIntWithDefault(30),
  DB_READY_INTERVAL_MS: positiveIntWithDefault(2000)
});

export type DbRuntimeConfig = z.output<typeof dbRuntimeConfigSchema>;

export class DbConfigValidationError extends Error {
  public constructor(public readonly issues: z.ZodIssue[]) {
    super("Invalid database runtime configuration");
    this.name = "DbConfigValidationError";
  }
}

export const loadDbRuntimeConfig = (env: NodeJS.ProcessEnv = process.env): DbRuntimeConfig => {
  const parsed = dbRuntimeConfigSchema.safeParse(env);
  if (!parsed.success) {
    throw new DbConfigValidationError(parsed.error.issues);
  }

  return parsed.data;
};

export const formatDbConfigValidationError = (error: unknown): string => {
  if (!(error instanceof DbConfigValidationError)) {
    return "Database configuration failed with an unknown error.";
  }

  const details = error.issues
    .map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");

  return `${error.message}\n${details}`;
};
