import { formatConfigValidationError, loadSupervisorWorkerConfig } from "@orkiva/shared";

const service = "supervisor-worker";

try {
  const config = loadSupervisorWorkerConfig(process.env);
  console.log(
    `[${service}] bootstrap complete (workspace=${config.WORKSPACE_ID}, pollIntervalMs=${config.WORKER_POLL_INTERVAL_MS})`
  );
} catch (error) {
  console.error(formatConfigValidationError(error));
  process.exit(1);
}
