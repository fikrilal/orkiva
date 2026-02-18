import { spawn } from "node:child_process";

import {
  prepareTriggerPayload,
  type TriggerDeliveryFailure,
  type TriggerDeliveryRequest,
  type TriggerDeliveryResult,
  type TriggerPtyAdapter
} from "./pty-adapter.js";

export interface CommandExecutionInput {
  command: string;
  args: readonly string[];
}

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  run(input: CommandExecutionInput): Promise<CommandExecutionResult>;
}

export class NodeCommandExecutor implements CommandExecutor {
  public run(input: CommandExecutionInput): Promise<CommandExecutionResult> {
    return new Promise<CommandExecutionResult>((resolve, reject) => {
      const child = spawn(input.command, [...input.args], {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr
        });
      });
    });
  }
}

const toFailure = (
  errorCode: TriggerDeliveryFailure["errorCode"],
  details?: Record<string, unknown>
): TriggerDeliveryFailure => ({
  delivered: false,
  errorCode,
  ...(details === undefined ? {} : { details })
});

const splitLines = (value: string): readonly string[] => value.replace(/\n$/, "").split("\n");

const livenessProbeTemplate = "#{pane_dead}|#{pane_pid}|#{pane_current_command}";

export const resolveTmuxTargetFromRuntime = (runtime: string): string | null => {
  const trimmed = runtime.trim();
  if (trimmed.startsWith("tmux://")) {
    const target = trimmed.slice("tmux://".length).trim();
    return target.length === 0 ? null : target;
  }
  if (trimmed.startsWith("tmux:")) {
    const target = trimmed.slice("tmux:".length).trim();
    return target.length === 0 ? null : target;
  }
  if (trimmed.includes(":") && trimmed.includes(".")) {
    return trimmed;
  }
  return null;
};

export class TmuxTriggerPtyAdapter implements TriggerPtyAdapter {
  public constructor(
    private readonly commandExecutor: CommandExecutor = new NodeCommandExecutor(),
    private readonly maxPayloadBytes?: number
  ) {}

  private async sendLiteralLine(target: string, line: string): Promise<boolean> {
    const sendText = await this.commandExecutor.run({
      command: "tmux",
      args: ["send-keys", "-t", target, "-l", line]
    });
    if (sendText.exitCode !== 0) {
      return false;
    }

    const sendEnter = await this.commandExecutor.run({
      command: "tmux",
      args: ["send-keys", "-t", target, "C-m"]
    });
    return sendEnter.exitCode === 0;
  }

  public async deliver(input: TriggerDeliveryRequest): Promise<TriggerDeliveryResult> {
    const target = resolveTmuxTargetFromRuntime(input.runtime.runtime);
    if (target === null) {
      return toFailure("UNSUPPORTED_RUNTIME", {
        runtime: input.runtime.runtime
      });
    }

    const payload = prepareTriggerPayload(
      {
        triggerId: input.triggerId,
        threadId: input.threadId,
        reason: input.reason,
        prompt: input.prompt
      },
      this.maxPayloadBytes
    );
    if (!payload.ok) {
      return toFailure(payload.errorCode, payload.details);
    }

    const probe = await this.commandExecutor.run({
      command: "tmux",
      args: ["display-message", "-p", "-t", target, livenessProbeTemplate]
    });
    if (probe.exitCode !== 0) {
      return toFailure("TARGET_NOT_FOUND", {
        target,
        stderr: probe.stderr.trim()
      });
    }

    const [paneDead, panePid, paneCommand] = splitLines(probe.stdout)[0]?.split("|") ?? [];
    if (paneDead === "1") {
      return toFailure("PANE_DEAD", {
        target,
        panePid: panePid ?? null,
        paneCommand: paneCommand ?? null
      });
    }

    for (const line of payload.value.envelopeLines) {
      const deliveredLine = await this.sendLiteralLine(target, line);
      if (!deliveredLine) {
        return toFailure("SEND_KEYS_ERROR", {
          target
        });
      }
    }

    return {
      delivered: true,
      details: {
        target
      }
    };
  }
}
