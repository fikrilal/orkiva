# SLO/SLI Baseline (MVP Pilot)

## Purpose

This document defines the reproducible measurement path for MVP pilot SLO/SLI targets and stores the latest measured baseline artifact.

## Measurement Command

Run:

```bash
tool/agent/pnpmw --no-stdin run ops:sli:pilot
```

Optional overrides:

```bash
tool/agent/pnpmw --no-stdin run ops:sli:pilot -- --iterations 200 --out docs/proposal/06-operations/reports/pilot_sli_baseline.json
```

## Latest Baseline Artifact

- JSON report: `docs/proposal/06-operations/reports/pilot_sli_baseline.json`
- Test guardrail: `apps/bridge-api/src/sli-benchmark.test.ts`
- Benchmark engine: `apps/bridge-api/src/sli-benchmark.ts`

## Target Mapping

| Metric | MVP target |
|---|---|
| post success rate | `>= 99.0%` |
| read success rate | `>= 99.5%` |
| p95 post-to-visible | `<= 2s` |
| p95 message-to-wake-trigger | `<= 3s` |

## Latest Measurement Snapshot

Measured at: `2026-02-18T13:24:15.663Z` (`iterations=120`)

| Metric | Measured | Target | Status |
|---|---:|---:|---|
| post success rate | `100%` | `>= 99.0%` | pass |
| read success rate | `100%` | `>= 99.5%` | pass |
| p95 post latency | `1.285ms` | informational | pass |
| p95 read latency | `2.552ms` | informational | pass |
| p95 post-to-visible | `4.322ms` | `<= 2000ms` | pass |
| p95 message-to-wake-trigger | `4.107ms` | `<= 3000ms` | pass |

## Interpretation

- Keep this baseline file under version control so changes in latency/reliability are diffable.
- Treat threshold regressions as release blockers until root cause and mitigation are documented.
