import { describe, expect, it, vi } from "vitest";

import {
  TmuxTriggerPtyAdapter,
  type CommandExecutionInput,
  type CommandExecutor,
  resolveTmuxTargetFromRuntime
} from "./tmux-adapter.js";
import type { RuntimeRegistryRecord } from "./runtime-registry.js";

const runtimeRecord = (runtime: string): RuntimeRegistryRecord => ({
  agentId: "reviewer_agent",
  workspaceId: "wk_01",
  sessionId: "sess_01",
  runtime,
  managementMode: "managed",
  resumable: true,
  status: "active",
  lastHeartbeatAt: new Date("2026-02-18T10:00:00.000Z"),
  updatedAt: new Date("2026-02-18T10:00:00.000Z")
});

describe("resolveTmuxTargetFromRuntime", () => {
  it("resolves prefixed tmux runtimes", () => {
    expect(resolveTmuxTargetFromRuntime("tmux:agents_mobile_core:reviewer.0")).toBe(
      "agents_mobile_core:reviewer.0"
    );
    expect(resolveTmuxTargetFromRuntime("tmux://agents_mobile_core:reviewer.0")).toBe(
      "agents_mobile_core:reviewer.0"
    );
  });

  it("resolves raw tmux target strings", () => {
    expect(resolveTmuxTargetFromRuntime("agents_mobile_core:reviewer.0")).toBe(
      "agents_mobile_core:reviewer.0"
    );
  });

  it("rejects non-tmux runtime strings", () => {
    expect(resolveTmuxTargetFromRuntime("codex_cli")).toBeNull();
  });
});

describe("TmuxTriggerPtyAdapter", () => {
  it("returns unsupported-runtime when runtime cannot be mapped to tmux target", async () => {
    const run = vi.fn();
    const commandExecutor: CommandExecutor = {
      run
    };
    const adapter = new TmuxTriggerPtyAdapter(commandExecutor);

    const result = await adapter.deliver({
      runtime: runtimeRecord("codex_cli"),
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "continue"
    });

    expect(result).toEqual({
      delivered: false,
      errorCode: "UNSUPPORTED_RUNTIME",
      details: {
        runtime: "codex_cli"
      }
    });
  });

  it("returns target-not-found when pane lookup fails", async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "can't find pane"
      })
    );
    const commandExecutor: CommandExecutor = {
      run
    };
    const adapter = new TmuxTriggerPtyAdapter(commandExecutor);

    const result = await adapter.deliver({
      runtime: runtimeRecord("tmux:agents_mobile_core:reviewer.0"),
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "continue"
    });

    expect(result).toEqual({
      delivered: false,
      errorCode: "TARGET_NOT_FOUND",
      details: {
        target: "agents_mobile_core:reviewer.0",
        stderr: "can't find pane"
      }
    });
  });

  it("returns pane-dead when tmux reports dead pane", async () => {
    const run = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stdout: "1|4242|bash\n",
        stderr: ""
      })
    );
    const commandExecutor: CommandExecutor = {
      run
    };
    const adapter = new TmuxTriggerPtyAdapter(commandExecutor);

    const result = await adapter.deliver({
      runtime: runtimeRecord("tmux:agents_mobile_core:reviewer.0"),
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "continue"
    });

    expect(result).toEqual({
      delivered: false,
      errorCode: "PANE_DEAD",
      details: {
        target: "agents_mobile_core:reviewer.0",
        panePid: "4242",
        paneCommand: "bash"
      }
    });
  });

  it("sends envelope lines to tmux when pane is healthy", async () => {
    const run = vi.fn((input: CommandExecutionInput) => {
      if (input.args[0] === "display-message") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "0|1234|codex\n",
          stderr: ""
        });
      }

      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: ""
      });
    });
    const commandExecutor: CommandExecutor = {
      run
    };
    const adapter = new TmuxTriggerPtyAdapter(commandExecutor);

    const result = await adapter.deliver({
      runtime: runtimeRecord("tmux:agents_mobile_core:reviewer.0"),
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "line-1\nline-2"
    });

    expect(result).toEqual({
      delivered: true,
      details: {
        target: "agents_mobile_core:reviewer.0"
      }
    });
    expect(run).toHaveBeenCalledWith({
      command: "tmux",
      args: [
        "display-message",
        "-p",
        "-t",
        "agents_mobile_core:reviewer.0",
        "#{pane_dead}|#{pane_pid}|#{pane_current_command}"
      ]
    });
    expect(run).toHaveBeenCalledWith({
      command: "tmux",
      args: [
        "send-keys",
        "-t",
        "agents_mobile_core:reviewer.0",
        "-l",
        "[BRIDGE_TRIGGER id=trg_01 thread=th_01 reason=new_unread_messages]"
      ]
    });
    expect(run).toHaveBeenCalledWith({
      command: "tmux",
      args: ["send-keys", "-t", "agents_mobile_core:reviewer.0", "-l", "[/BRIDGE_TRIGGER]"]
    });
  });

  it("returns send-keys-error when tmux send operation fails", async () => {
    const run = vi.fn((input: CommandExecutionInput) => {
      if (input.args[0] === "display-message") {
        return Promise.resolve({
          exitCode: 0,
          stdout: "0|1234|codex\n",
          stderr: ""
        });
      }
      if (input.args[0] === "send-keys" && input.args[3] === "-l") {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "send failed"
        });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: ""
      });
    });
    const commandExecutor: CommandExecutor = {
      run
    };
    const adapter = new TmuxTriggerPtyAdapter(commandExecutor);

    const result = await adapter.deliver({
      runtime: runtimeRecord("tmux:agents_mobile_core:reviewer.0"),
      triggerId: "trg_01",
      threadId: "th_01",
      reason: "new_unread_messages",
      prompt: "continue"
    });

    expect(result).toEqual({
      delivered: false,
      errorCode: "SEND_KEYS_ERROR",
      details: {
        target: "agents_mobile_core:reviewer.0"
      }
    });
  });
});
