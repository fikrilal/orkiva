import { z, type ZodError, type ZodIssue } from "zod";

type EnvInput = NodeJS.ProcessEnv;

const stringWithDefault = (value: string) => z.string().optional().default(value);

const positiveIntWithDefault = (value: number) =>
  z
    .string()
    .optional()
    .default(String(value))
    .transform((raw) => Number(raw))
    .pipe(z.number().int().positive());

const nonNegativeIntWithDefault = (value: number) =>
  z
    .string()
    .optional()
    .default(String(value))
    .transform((raw) => Number(raw))
    .pipe(z.number().int().nonnegative());

const booleanWithDefault = (value: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .default(value ? "true" : "false")
    .transform((raw) => raw === "true");

const disabledAutomationFlag = z
  .enum(["false"])
  .optional()
  .default("false")
  .transform(() => false);

const runtimeConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),
  WORKSPACE_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  AUTH_JWKS_URL: z.string().url(),
  AUTH_ISSUER: z.string().min(1),
  AUTH_AUDIENCE: stringWithDefault("orkiva"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .optional()
    .default("info"),
  METRICS_ENABLED: booleanWithDefault(true),
  METRICS_PORT: positiveIntWithDefault(9464),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  RETENTION_MODE: z.enum(["permanent"]).optional().default("permanent"),
  ENABLE_AUTOMATED_REDACTION: disabledAutomationFlag,
  TRIGGER_ACK_TIMEOUT_MS: positiveIntWithDefault(8000),
  TRIGGER_MAX_RETRIES: nonNegativeIntWithDefault(2),
  TRIGGER_RESUME_MAX_ATTEMPTS: positiveIntWithDefault(2),
  TRIGGER_QUIET_WINDOW_MS: positiveIntWithDefault(20000),
  TRIGGER_RECHECK_MS: positiveIntWithDefault(5000),
  TRIGGER_MAX_DEFER_MS: positiveIntWithDefault(60000),
  LOOP_MAX_TURNS: positiveIntWithDefault(20),
  LOOP_MAX_REPEATED_FINDINGS: positiveIntWithDefault(3),
  SESSION_STALE_AFTER_HOURS: positiveIntWithDefault(12)
});

const bridgeApiConfigSchema = runtimeConfigSchema.extend({
  API_HOST: stringWithDefault("0.0.0.0"),
  API_PORT: positiveIntWithDefault(3000)
});

const supervisorWorkerConfigSchema = runtimeConfigSchema.extend({
  WORKER_POLL_INTERVAL_MS: positiveIntWithDefault(5000),
  WORKER_MAX_PARALLEL_JOBS: positiveIntWithDefault(10)
});

const operatorCliConfigSchema = runtimeConfigSchema.extend({
  OPERATOR_OUTPUT_FORMAT: z.enum(["json", "pretty"]).optional().default("pretty")
});

export type BridgeApiConfig = z.output<typeof bridgeApiConfigSchema>;
export type SupervisorWorkerConfig = z.output<typeof supervisorWorkerConfigSchema>;
export type OperatorCliConfig = z.output<typeof operatorCliConfigSchema>;

export class ConfigValidationError extends Error {
  public readonly service: string;
  public readonly issues: ZodIssue[];

  public constructor(service: string, error: ZodError) {
    super(`Invalid ${service} runtime configuration`);
    this.name = "ConfigValidationError";
    this.service = service;
    this.issues = error.issues;
  }
}

const parseOrThrow = <Output, Input>(
  schema: z.ZodType<Output, z.ZodTypeDef, Input>,
  env: unknown,
  serviceName: string
): Output => {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(serviceName, result.error);
  }

  return result.data;
};

export const loadBridgeApiConfig = (env: EnvInput = process.env): BridgeApiConfig =>
  parseOrThrow(bridgeApiConfigSchema, env, "bridge-api");

export const loadSupervisorWorkerConfig = (env: EnvInput = process.env): SupervisorWorkerConfig =>
  parseOrThrow(supervisorWorkerConfigSchema, env, "supervisor-worker");

export const loadOperatorCliConfig = (env: EnvInput = process.env): OperatorCliConfig =>
  parseOrThrow(operatorCliConfigSchema, env, "operator-cli");

export const formatConfigValidationError = (error: unknown): string => {
  if (!(error instanceof ConfigValidationError)) {
    return "Runtime configuration failed with an unknown error.";
  }

  const details = error.issues
    .map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");

  return `${error.message}\n${details}`;
};
