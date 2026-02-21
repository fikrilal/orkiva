import { createAccessTokenVerifier } from "@orkiva/auth";
import { createDb, createDbPool } from "@orkiva/db";
import { createJsonLogger } from "@orkiva/observability";
import { formatConfigValidationError, loadBridgeApiConfig } from "@orkiva/shared";

import { createBridgeApiApp } from "./app.js";
import { DbAuditStore } from "./audit-store.js";
import { DbSessionStore } from "./session-store.js";
import { DbThreadStore } from "./thread-store.js";
import { DbTriggerStore } from "./trigger-store.js";

const service = "bridge-api";
const logger = createJsonLogger(service);

try {
  const config = loadBridgeApiConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);
  const threadStore = new DbThreadStore(db);
  const sessionStore = new DbSessionStore(db);
  const triggerStore = new DbTriggerStore(db);
  const auditStore = new DbAuditStore(db);
  const verifierOptions =
    config.AUTH_JWKS_JSON !== undefined
      ? {
          issuer: config.AUTH_ISSUER,
          audience: config.AUTH_AUDIENCE,
          jwksJson: config.AUTH_JWKS_JSON
        }
      : {
          issuer: config.AUTH_ISSUER,
          audience: config.AUTH_AUDIENCE,
          jwksUrl:
            config.AUTH_JWKS_URL ??
            (() => {
              throw new Error("AUTH_JWKS_URL is required when AUTH_JWKS_JSON is not provided");
            })()
        };
  const verifyAccessToken = createAccessTokenVerifier(verifierOptions);
  const app = createBridgeApiApp({
    workspaceId: config.WORKSPACE_ID,
    threadStore,
    sessionStore,
    triggerStore,
    auditStore,
    verifyAccessToken,
    sessionStaleAfterHours: config.SESSION_STALE_AFTER_HOURS,
    triggerMaxRetries: config.TRIGGER_MAX_RETRIES,
    readinessCheck: () =>
      dbPool
        .query("select 1 as ok")
        .then(() => true)
        .catch(() => false)
  });

  const closeResources = async (): Promise<void> => {
    await app.close();
    await dbPool.end();
  };

  process.on("SIGINT", () => {
    void closeResources().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void closeResources().finally(() => process.exit(0));
  });

  app
    .listen({
      host: config.API_HOST,
      port: config.API_PORT
    })
    .then(() => {
      logger.info("bootstrap.complete", {
        host: config.API_HOST,
        port: config.API_PORT,
        workspace: config.WORKSPACE_ID
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("bootstrap.failed", {
        error: message
      });
      void closeResources().finally(() => process.exit(1));
    });
} catch (error) {
  logger.error("config.invalid", {
    error: formatConfigValidationError(error)
  });
  process.exit(1);
}
