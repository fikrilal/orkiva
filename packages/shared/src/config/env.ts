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

const optionalIsoDateTime = z
  .string()
  .datetime({
    offset: true
  })
  .optional()
  .transform((raw) => (raw === undefined ? undefined : new Date(raw)));

const disabledAutomationFlag = z
  .enum(["false"])
  .optional()
  .default("false")
  .transform(() => false);

const runtimeConfigBaseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),
  WORKSPACE_ID: z.string().min(1),
  DATABASE_URL: z.string().url(),
  AUTH_JWKS_URL: z.string().url().optional(),
  AUTH_JWKS_JSON: z.string().min(1).optional(),
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
  TRIGGER_RATE_LIMIT_PER_MINUTE: positiveIntWithDefault(10),
  AUTO_UNREAD_ENABLED: booleanWithDefault(true),
  AUTO_UNREAD_MAX_TRIGGERS_PER_WINDOW: positiveIntWithDefault(3),
  AUTO_UNREAD_WINDOW_MS: positiveIntWithDefault(300000),
  AUTO_UNREAD_MIN_INTERVAL_MS: positiveIntWithDefault(30000),
  AUTO_UNREAD_BREAKER_BACKLOG_THRESHOLD: positiveIntWithDefault(50),
  AUTO_UNREAD_BREAKER_COOLDOWN_MS: positiveIntWithDefault(60000),
  TRIGGERING_LEASE_TIMEOUT_MS: positiveIntWithDefault(45000),
  LOOP_MAX_TURNS: positiveIntWithDefault(20),
  LOOP_MAX_REPEATED_FINDINGS: positiveIntWithDefault(3),
  SESSION_STALE_AFTER_HOURS: positiveIntWithDefault(12),
  WORKER_BRIDGE_API_BASE_URL: stringWithDefault("http://127.0.0.1:3000"),
  WORKER_BRIDGE_ACCESS_TOKEN: z.string().min(1).optional(),
  WORKER_MIN_JOB_CREATED_AT: optionalIsoDateTime,
  WORKER_CALLBACK_MAX_RETRIES: positiveIntWithDefault(3),
  WORKER_CALLBACK_REQUEST_TIMEOUT_MS: positiveIntWithDefault(8000)
});

const withAuthConfigGuard = <Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>
): z.ZodEffects<z.ZodObject<Shape>> =>
  schema.superRefine((config, ctx) => {
    if (config["AUTH_JWKS_URL"] === undefined && config["AUTH_JWKS_JSON"] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["AUTH_JWKS_URL"],
        message: 'Either "AUTH_JWKS_URL" or "AUTH_JWKS_JSON" is required'
      });
    }
  });

const bridgeApiConfigSchema = withAuthConfigGuard(
  runtimeConfigBaseSchema.extend({
    API_HOST: stringWithDefault("0.0.0.0"),
    API_PORT: positiveIntWithDefault(3000)
  })
);

const supervisorWorkerConfigSchema = withAuthConfigGuard(
  runtimeConfigBaseSchema.extend({
    WORKER_POLL_INTERVAL_MS: positiveIntWithDefault(5000),
    WORKER_MAX_PARALLEL_JOBS: positiveIntWithDefault(10),
    WORKER_FALLBACK_ALLOW_DANGEROUS_BYPASS: booleanWithDefault(false),
    WORKER_FALLBACK_EXEC_TIMEOUT_MS: positiveIntWithDefault(900000),
    WORKER_FALLBACK_KILL_GRACE_MS: positiveIntWithDefault(5000),
    WORKER_FALLBACK_MAX_ACTIVE_GLOBAL: positiveIntWithDefault(8),
    WORKER_FALLBACK_MAX_ACTIVE_PER_AGENT: positiveIntWithDefault(2)
  })
);

const operatorCliConfigSchema = withAuthConfigGuard(
  runtimeConfigBaseSchema.extend({
    OPERATOR_OUTPUT_FORMAT: z.enum(["json", "pretty"]).optional().default("pretty")
  })
);

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
