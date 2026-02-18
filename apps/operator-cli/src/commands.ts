const DEFAULT_LIMIT_MESSAGES = 20;
const DEFAULT_LIMIT_TRIGGERS = 20;

export type OperatorCommand =
  | {
      kind: "inspect-thread";
      threadId: string;
      limitMessages: number;
      limitTriggers: number;
      json: boolean;
    }
  | {
      kind: "escalate-thread";
      threadId: string;
      reason: string;
      actorAgentId: string;
      json: boolean;
    }
  | {
      kind: "unblock-thread";
      threadId: string;
      reason: string;
      actorAgentId: string;
      json: boolean;
    }
  | {
      kind: "override-close-thread";
      threadId: string;
      reason: string;
      actorAgentId: string;
      json: boolean;
    };

const parseOptions = (argv: readonly string[]): Map<string, string> => {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (key.length === 0) {
      throw new Error("Invalid empty option name");
    }

    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options.set(key, "true");
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  return options;
};

const readRequiredString = (options: Map<string, string>, key: string): string => {
  const value = options.get(key);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
};

const readOptionalPositiveInt = (
  options: Map<string, string>,
  key: string,
  fallback: number
): number => {
  const raw = options.get(key);
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Option --${key} must be a positive integer`);
  }
  return value;
};

const readOptionalBool = (options: Map<string, string>, key: string): boolean => {
  const raw = options.get(key);
  if (raw === undefined) {
    return false;
  }

  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`Option --${key} must be true or false`);
};

const readActorAgentId = (options: Map<string, string>): string => {
  const value = options.get("actor-agent-id");
  if (value === undefined) {
    return "human_operator";
  }
  if (value.trim().length === 0) {
    throw new Error("Option --actor-agent-id must not be empty");
  }

  return value;
};

export const parseOperatorCommand = (argv: readonly string[]): OperatorCommand => {
  const [commandName, ...rest] = argv;
  if (commandName === undefined) {
    throw new Error(
      "Missing command. Expected inspect-thread | escalate-thread | unblock-thread | override-close-thread"
    );
  }

  const options = parseOptions(rest);
  const json = readOptionalBool(options, "json");

  if (commandName === "inspect-thread") {
    return {
      kind: "inspect-thread",
      threadId: readRequiredString(options, "thread-id"),
      limitMessages: readOptionalPositiveInt(options, "limit-messages", DEFAULT_LIMIT_MESSAGES),
      limitTriggers: readOptionalPositiveInt(options, "limit-triggers", DEFAULT_LIMIT_TRIGGERS),
      json
    };
  }

  if (commandName === "escalate-thread") {
    return {
      kind: "escalate-thread",
      threadId: readRequiredString(options, "thread-id"),
      reason: readRequiredString(options, "reason"),
      actorAgentId: readActorAgentId(options),
      json
    };
  }

  if (commandName === "unblock-thread") {
    return {
      kind: "unblock-thread",
      threadId: readRequiredString(options, "thread-id"),
      reason: readRequiredString(options, "reason"),
      actorAgentId: readActorAgentId(options),
      json
    };
  }

  if (commandName === "override-close-thread") {
    return {
      kind: "override-close-thread",
      threadId: readRequiredString(options, "thread-id"),
      reason: readRequiredString(options, "reason"),
      actorAgentId: readActorAgentId(options),
      json
    };
  }

  throw new Error(`Unknown command: ${commandName}`);
};
