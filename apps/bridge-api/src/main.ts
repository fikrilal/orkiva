import { formatConfigValidationError, loadBridgeApiConfig } from "@orkiva/shared";

const service = "bridge-api";

try {
  const config = loadBridgeApiConfig(process.env);
  console.log(
    `[${service}] bootstrap complete (workspace=${config.WORKSPACE_ID}, host=${config.API_HOST}, port=${config.API_PORT})`
  );
} catch (error) {
  console.error(formatConfigValidationError(error));
  process.exit(1);
}
