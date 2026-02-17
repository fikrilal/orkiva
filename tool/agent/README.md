# Agent Windows Wrappers

Development-only wrappers for running Windows tools from a WSL agent session.

Purpose:
- Keep tool execution consistent with Windows-hosted dev environment.
- Avoid Linux/Windows toolchain artifact drift in a `/mnt/c/...` workspace.

Available wrappers:
- `tool/agent/winrun`: generic Windows command runner
- `tool/agent/gitw`: Windows `git`
- `tool/agent/nodew`: Windows `node`
- `tool/agent/pnpmw`: Windows `pnpm`
- `tool/agent/dockw`: Windows `docker`
- `tool/agent/doctor`: preflight checks

Examples:
```bash
tool/agent/doctor
tool/agent/gitw status
tool/agent/nodew --version
tool/agent/pnpmw install
tool/agent/dockw compose up -d
```

Notes:
- These scripts are for development workflow only, not product runtime.
- Use `--no-stdin` in automation/non-interactive agent flows.
