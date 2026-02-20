export interface LogContext {
  [key: string]: string | number | boolean | null | undefined;
}

export interface JsonLogger {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const writeLog = (
  level: "info" | "warn" | "error",
  service: string,
  message: string,
  context?: LogContext
): void => {
  const record = {
    level,
    service,
    message,
    ts: new Date().toISOString(),
    ...(context === undefined ? {} : { context })
  };
  const line = JSON.stringify(record);
  const stream = level === "info" ? process.stdout : process.stderr;
  stream.write(`${line}\n`);
};

export const createJsonLogger = (service: string): JsonLogger => ({
  info: (message, context) => writeLog("info", service, message, context),
  warn: (message, context) => writeLog("warn", service, message, context),
  error: (message, context) => writeLog("error", service, message, context)
});

interface CounterDefinition {
  help: string;
  labelNames: readonly string[];
}

export class MetricsRegistry {
  private readonly definitions = new Map<string, CounterDefinition>();
  private readonly samples = new Map<string, number>();

  public incrementCounter(
    name: string,
    input?: {
      help?: string;
      labels?: Record<string, string>;
      value?: number;
    }
  ): void {
    const help = input?.help ?? `${name} counter`;
    const labels = input?.labels ?? {};
    const value = input?.value ?? 1;
    const labelNames = Object.keys(labels).sort();
    const existingDefinition = this.definitions.get(name);
    if (existingDefinition === undefined) {
      this.definitions.set(name, {
        help,
        labelNames
      });
    }

    const sampleKey = `${name}|${labelNames.map((labelName) => `${labelName}=${labels[labelName]}`).join(",")}`;
    const current = this.samples.get(sampleKey) ?? 0;
    this.samples.set(sampleKey, current + value);
  }

  public renderPrometheus(): string {
    const lines: string[] = [];
    const sortedNames = [...this.definitions.keys()].sort();
    for (const name of sortedNames) {
      const definition = this.definitions.get(name);
      if (!definition) {
        continue;
      }
      lines.push(`# HELP ${name} ${definition.help}`);
      lines.push(`# TYPE ${name} counter`);
      const matchingSamples = [...this.samples.entries()]
        .filter(([key]) => key.startsWith(`${name}|`))
        .sort(([left], [right]) => left.localeCompare(right));
      for (const [sampleKey, value] of matchingSamples) {
        const labelsRaw = sampleKey.slice(name.length + 1);
        if (labelsRaw.length === 0) {
          lines.push(`${name} ${value}`);
          continue;
        }
        const labels = labelsRaw
          .split(",")
          .filter((label) => label.length > 0)
          .map((entry) => {
            const [labelName, ...rest] = entry.split("=");
            const labelValue = rest.join("=").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
            return `${labelName}="${labelValue}"`;
          })
          .join(",");
        lines.push(`${name}{${labels}} ${value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
}
