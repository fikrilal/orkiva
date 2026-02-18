# Release Tag Plan (MVP Pilot)

## Objective

Establish a safe, repeatable tagging process for Orkiva MVP pilot releases.

## Current Baseline

- Latest launch-readiness commit: `71fc6fd`
- Working policy: annotated tags only
- Scope: pilot release stream (pre-`1.0.0`)

## Tagging Convention

- Release candidate tags: `v0.1.0-rc.N` (example: `v0.1.0-rc.1`)
- Stable pilot tag: `v0.1.0`
- Hotfix tags: `v0.1.1`, `v0.1.2`, ...

Rationale:
- `0.x` communicates pre-GA maturity.
- `rc` tags provide a reversible checkpoint before stable cut.

## Candidate Release Commit Set

Core readiness path already landed:
- `042424c` Phase X security/load resilience coverage
- `54182b1` Phase Y SLO baseline and runbook readiness
- `71fc6fd` Phase Z launch readiness and handoff

Recommended stable tag target:
- `71fc6fd`

## Pre-Tag Gate (Mandatory)

From a clean workspace:

```bash
tool/agent/gitw --no-stdin status --short
tool/agent/pnpmw --no-stdin run verify
```

If either fails, do not tag.

## Tag Cut Procedure

### 1) Optional release candidate

```bash
tool/agent/gitw --no-stdin tag -a v0.1.0-rc.1 71fc6fd -m "release: v0.1.0-rc.1 (mvp pilot candidate)"
tool/agent/gitw --no-stdin show v0.1.0-rc.1 --no-patch --pretty=fuller
```

### 2) Stable pilot release tag

```bash
tool/agent/gitw --no-stdin tag -a v0.1.0 71fc6fd -m "release: v0.1.0 (mvp pilot)"
tool/agent/gitw --no-stdin show v0.1.0 --no-patch --pretty=fuller
```

### 3) Push tags

```bash
tool/agent/gitw --no-stdin push origin v0.1.0
# If using RC flow:
tool/agent/gitw --no-stdin push origin v0.1.0-rc.1
```

## Post-Tag Checks

```bash
tool/agent/gitw --no-stdin ls-remote --tags origin
tool/agent/gitw --no-stdin describe --tags --always
```

Confirm:
- tag points to expected commit (`71fc6fd`)
- release notes include known risks from `launch_readiness_and_handoff.md`

## Rollback / Correction Rules

- Do not move an already-published stable tag.
- If a bad stable tag is published:
1. keep the original tag immutable
2. cut a corrective patch tag (`v0.1.1`) from the fix commit
3. document supersession in release notes

- If an RC tag is wrong and not yet used externally, delete and recreate:

```bash
tool/agent/gitw --no-stdin tag -d v0.1.0-rc.1
tool/agent/gitw --no-stdin push origin :refs/tags/v0.1.0-rc.1
```

## Minimal Release Notes Template

```markdown
## v0.1.0 - MVP Pilot

### Included
- Phase X: security/load resilience suite
- Phase Y: SLO baseline + runbook drill readiness
- Phase Z: launch handoff, risk register, rollback plan

### Verification
- `pnpm run verify` passed on release commit

### Known risks
- see `docs/proposal/06-operations/launch_readiness_and_handoff.md`
```
