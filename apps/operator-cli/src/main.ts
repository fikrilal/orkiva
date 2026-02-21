import { createDb, createDbPool } from "@orkiva/db";
import { formatConfigValidationError, loadOperatorCliConfig } from "@orkiva/shared";

import { parseOperatorCommand } from "./commands.js";
import { DbOperatorRepository, OperatorCliError, OperatorCliService } from "./service.js";

const service = "operator-cli";

const printUsage = (): void => {
  const usage = `
Usage:
  operator-cli inspect-thread --thread-id <id> [--limit-messages <n>] [--limit-triggers <n>] [--json]
  operator-cli escalate-thread --thread-id <id> --reason <text> [--actor-agent-id <agent>] [--json]
  operator-cli unblock-thread --thread-id <id> --reason <text> [--actor-agent-id <agent>] [--json]
  operator-cli assign-escalation-owner --thread-id <id> --owner-agent-id <agent> --reason <text> [--actor-agent-id <agent>] [--json]
  operator-cli reassign-escalation-owner --thread-id <id> --owner-agent-id <agent> --reason <text> [--actor-agent-id <agent>] [--json]
  operator-cli get-escalation-owner --thread-id <id> [--json]
  operator-cli override-close-thread --thread-id <id> --reason <human_override:...> [--actor-agent-id <agent>] [--json]
  operator-cli fallback-list [--status running|all] [--limit <n>] [--json]
  operator-cli fallback-kill (--trigger-id <id> | --thread-id <id>) --reason <text> [--actor-agent-id <agent>] [--json]
`.trim();
  process.stdout.write(`${usage}\n`);
};

const writeOutput = (input: {
  format: "json" | "pretty";
  forceJson: boolean;
  payload: unknown;
}): void => {
  const shouldPretty = !input.forceJson && input.format === "pretty";
  const serialized = shouldPretty
    ? JSON.stringify(input.payload, null, 2)
    : JSON.stringify(input.payload);
  process.stdout.write(`${serialized}\n`);
};

const writeError = (payload: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
};

const run = async (): Promise<number> => {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "help") {
    printUsage();
    return 0;
  }

  let dbPool: Awaited<ReturnType<typeof createDbPool>> | null = null;
  try {
    const config = loadOperatorCliConfig(process.env);
    const command = parseOperatorCommand(argv);
    dbPool = createDbPool(config.DATABASE_URL);
    const db = createDb(dbPool);
    const serviceInstance = new OperatorCliService(
      new DbOperatorRepository(db),
      config.WORKSPACE_ID
    );
    const result = await serviceInstance.execute(command);
    writeOutput({
      format: config.OPERATOR_OUTPUT_FORMAT,
      forceJson: command.json,
      payload: result
    });
    return 0;
  } catch (error) {
    if (error instanceof OperatorCliError) {
      writeError({
        ok: false,
        service,
        code: error.code,
        message: error.message
      });
      return 1;
    }

    if (error instanceof Error) {
      if (error.name === "ConfigValidationError") {
        writeError({
          ok: false,
          service,
          code: "CONFIG_INVALID",
          message: formatConfigValidationError(error)
        });
        return 1;
      }
      writeError({
        ok: false,
        service,
        code: "UNHANDLED_ERROR",
        message: error.message
      });
      return 1;
    }

    writeError({
      ok: false,
      service,
      code: "UNHANDLED_ERROR",
      message: "Unknown runtime error"
    });
    return 1;
  } finally {
    if (dbPool !== null) {
      await dbPool.end();
    }
  }
};

void run().then((exitCode) => {
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
});
