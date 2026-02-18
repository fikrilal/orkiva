import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runInMemorySliBenchmark } from "../../apps/bridge-api/src/sli-benchmark.js";

interface CliArgs {
  outPath: string;
  iterations: number;
}

const DEFAULT_OUTPUT_PATH = "docs/proposal/06-operations/reports/pilot_sli_baseline.json";
const DEFAULT_ITERATIONS = 120;

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received: ${value}`);
  }

  return parsed;
};

const parseCliArgs = (argv: readonly string[]): CliArgs => {
  let outPath = DEFAULT_OUTPUT_PATH;
  let iterations = DEFAULT_ITERATIONS;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      outPath = argv[index + 1] ?? outPath;
      index += 1;
      continue;
    }
    if (arg === "--iterations") {
      iterations = parsePositiveInteger(argv[index + 1], iterations);
      index += 1;
      continue;
    }
  }

  return {
    outPath,
    iterations
  };
};

const main = async (): Promise<void> => {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await runInMemorySliBenchmark({
    iterations: args.iterations
  });
  const outputPath = resolve(args.outPath);
  await mkdir(dirname(outputPath), {
    recursive: true
  });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`pilot-sli-baseline: wrote report to ${outputPath}\n`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pilot-sli-baseline: failed: ${message}\n`);
  process.exitCode = 1;
});
