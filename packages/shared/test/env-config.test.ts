import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  formatConfigValidationError,
  loadBridgeApiConfig,
  loadSupervisorWorkerConfig
} from "../src/index.js";

const baseEnv = {
  WORKSPACE_ID: "wk_test",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/orkiva_test",
  AUTH_JWKS_URL: "http://localhost:8080/.well-known/jwks.json",
  AUTH_ISSUER: "https://issuer.test"
};

describe("runtime config contract", () => {
  it("applies bridge-api defaults", () => {
    const config = loadBridgeApiConfig(baseEnv);

    expect(config.API_HOST).toBe("0.0.0.0");
    expect(config.API_PORT).toBe(3000);
    expect(config.TRIGGER_MAX_RETRIES).toBe(2);
    expect(config.RETENTION_MODE).toBe("permanent");
    expect(config.ENABLE_AUTOMATED_REDACTION).toBe(false);
  });

  it("applies supervisor-worker defaults", () => {
    const config = loadSupervisorWorkerConfig(baseEnv);

    expect(config.WORKER_POLL_INTERVAL_MS).toBe(5000);
    expect(config.WORKER_MAX_PARALLEL_JOBS).toBe(10);
    expect(config.TRIGGER_QUIET_WINDOW_MS).toBe(20000);
    expect(config.TRIGGER_RATE_LIMIT_PER_MINUTE).toBe(10);
    expect(config.AUTO_UNREAD_MAX_TRIGGERS_PER_WINDOW).toBe(3);
    expect(config.AUTO_UNREAD_WINDOW_MS).toBe(300000);
    expect(config.AUTO_UNREAD_MIN_INTERVAL_MS).toBe(30000);
    expect(config.AUTO_UNREAD_BREAKER_BACKLOG_THRESHOLD).toBe(50);
    expect(config.AUTO_UNREAD_BREAKER_COOLDOWN_MS).toBe(60000);
    expect(config.TRIGGERING_LEASE_TIMEOUT_MS).toBe(45000);
  });

  it("fails fast when required env is missing", () => {
    expect(() => {
      loadBridgeApiConfig({
        ...baseEnv,
        WORKSPACE_ID: ""
      });
    }).toThrow(ConfigValidationError);
  });

  it("rejects automated redaction enablement in personal MVP", () => {
    expect(() => {
      loadSupervisorWorkerConfig({
        ...baseEnv,
        ENABLE_AUTOMATED_REDACTION: "true"
      });
    }).toThrow(ConfigValidationError);
  });

  it("formats validation errors with field-level details", () => {
    try {
      loadBridgeApiConfig({
        ...baseEnv,
        API_PORT: "invalid"
      });
      throw new Error("expected validation error");
    } catch (error) {
      const formatted = formatConfigValidationError(error);
      expect(formatted).toContain("Invalid bridge-api runtime configuration");
      expect(formatted).toContain("API_PORT");
    }
  });
});
