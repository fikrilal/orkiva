import { createAccessTokenVerifier } from "@orkiva/auth";
import { createDb, createDbPool } from "@orkiva/db";
import { formatConfigValidationError, loadBridgeApiConfig } from "@orkiva/shared";

import { createBridgeApiApp } from "./app.js";
import { DbThreadStore } from "./thread-store.js";

const service = "bridge-api";

try {
  const config = loadBridgeApiConfig(process.env);
  const dbPool = createDbPool(config.DATABASE_URL);
  const db = createDb(dbPool);
  const threadStore = new DbThreadStore(db);
  const verifyAccessToken = createAccessTokenVerifier({
    issuer: config.AUTH_ISSUER,
    audience: config.AUTH_AUDIENCE,
    jwksUrl: config.AUTH_JWKS_URL
  });
  const app = createBridgeApiApp({
    threadStore,
    verifyAccessToken
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
      console.log(
        `[${service}] listening on ${config.API_HOST}:${config.API_PORT} (workspace=${config.WORKSPACE_ID})`
      );
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[${service}] failed to start: ${message}`);
      void closeResources().finally(() => process.exit(1));
    });
} catch (error) {
  console.error(formatConfigValidationError(error));
  process.exit(1);
}
