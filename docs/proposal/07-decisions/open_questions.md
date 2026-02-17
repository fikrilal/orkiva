# Open Questions and Decision Register

## Resolved Decisions

### Q1. Orchestration Model (Resolved 2026-02-17)
Question:
- Should agents poll independently, or should a coordinator process actively trigger agent sessions?

Decision:
- Hybrid orchestration for MVP.

Decision detail:
- Primary path: supervisor/orchestrator sends targeted wake triggers for dormant participants.
- Reliability path: polling fallback remains enabled to recover from missed triggers.
- Escalation path: if trigger + retry fail, fallback to `resume`/spawn flow.

Rationale:
- Balances autonomy and latency with operational resilience.
- Avoids hard dependency on a single activation mechanism.

Owner: Dante
Status: locked for MVP

### Q2. Storage Backend (Resolved 2026-02-17)
Question:
- Should MVP start with SQLite then migrate, or use Postgres from day one?

Decision:
- Use Postgres from day one.

Decision detail:
- MVP and pilot run on Postgres as primary durable store.
- SQLite-first migration track is removed from baseline plan.
- Keep storage abstraction so backend portability remains possible.

Rationale:
- Complexity is acceptable for the team.
- Reduces migration risk and lock-contention risk later.
- Better aligns with concurrent orchestration and audit query needs.

Owner: Dante
Status: locked for MVP

### Q3. Identity Trust Boundary (Resolved 2026-02-17)
Question:
- Is `agent_id` issued by platform auth, or provided by runtime and verified externally?

Decision:
- Use platform-issued identity with signed short-lived tokens.

Decision detail:
- Every bridge call must be authenticated with a platform-issued token.
- Authorization relies on verified token claims, not raw payload identity fields.
- Required claims baseline: `agent_id`, `workspace_id`, `role`, `session_id`, `iat`, `exp`, `jti`.

Rationale:
- Prevents agent impersonation via runtime-asserted identity strings.
- Makes routing, ACLs, and audit logs trustworthy.

Owner: Dante
Status: locked for MVP

### Q4. Message Retention Policy (Resolved 2026-02-17)
Question:
- What retention periods apply by workspace sensitivity level?

Decision:
- Personal MVP uses permanent retention (no automatic expiry).

Decision detail:
- Messages and metadata are retained indefinitely for current personal usage.
- Retention tiers and automated expiry are deferred as future enhancement.

Rationale:
- Avoids spending time on policy machinery before real multi-tenant needs exist.
- Preserves full history for personal workflow continuity.

Owner: Dante
Status: locked for personal MVP

### Q5. Content Filtering (Resolved 2026-02-17)
Question:
- Should sensitive data redaction happen inline at write time, read time, or both?

Decision:
- No automated content filtering/redaction in personal MVP.

Decision detail:
- Bridge stores content as provided.
- Secret hygiene remains operator responsibility for now.
- Automated filtering/redaction remains a future enhancement.

Rationale:
- Keeps initial implementation simple and faster to ship for personal use.

Owner: Dante
Status: locked for personal MVP

### Q6. Conflict Resolution Authority (Resolved 2026-02-17)
Question:
- Who can force-close or override thread status during disagreements?

Decision:
- Human operator has final override authority.
- Orchestrator has operational control authority.
- Worker agents cannot force-close disputed threads.

Decision detail:
- Orchestrator may set `blocked`, `reopen`, and `needs_human_decision`.
- Final dispute override actions require human operator intent and reason.
- Override events must be immutable and auditable.

Rationale:
- Prevents unilateral close by worker agents.
- Keeps final risk ownership with human operator.

Owner: Dante
Status: locked for MVP

### Q7. Human UI Needs (Resolved 2026-02-17)
Question:
- Is CLI/JSON output enough in MVP, or is a minimal web dashboard required?

Decision:
- CLI/JSON is sufficient for MVP.

Decision detail:
- No web dashboard is required in MVP.
- Human operation/inspection relies on terminal + tmux + structured JSON outputs.
- UI/dashboard remains future enhancement.

Rationale:
- Minimizes build scope and accelerates personal MVP delivery.

Owner: Dante
Status: locked for MVP

### Q8. Cross-Workspace or Cross-Org Support (Resolved 2026-02-17)
Question:
- Should architecture intentionally support future federation, or remain single-workspace only for first versions?

Decision:
- MVP is single-workspace only (single trust domain).

Decision detail:
- No cross-workspace or cross-organization message routing in MVP.
- Tokens, ACLs, threads, and runtime control are scoped to one workspace boundary.
- Federation is deferred as future enhancement.

Rationale:
- Reduces identity/policy complexity for personal MVP.
- Keeps isolation guarantees clear and implementable.

Owner: Dante
Status: locked for MVP

### Q9. Versioning Strategy (Resolved 2026-02-17)
Question:
- Use endpoint versioning (`/v1/...`) only, or explicit schema versions in payload as well?

Decision:
- Use dual versioning: endpoint major version + payload schema version.

Decision detail:
- API surface starts at `/v1`.
- Message/event payloads include `schema_version` (or `event_version`) for compatibility control.
- Additive payload changes are preferred; breaking changes require endpoint major bump.

Rationale:
- Supports forward/backward compatibility for long-lived worker runtimes.
- Avoids unnecessary early endpoint major churn.

Owner: Dante
Status: locked for MVP

### Q10. Autonomous Loop Safeguards (Resolved 2026-02-17)
Question:
- Which loop thresholds are safe defaults for development vs production workspaces?

Decision:
- Personal MVP loop guard uses explicit no-progress thresholds with auto-block and escalation.

Decision detail:
- Auto-block when no-progress conversation reaches `20` turns.
- Auto-block when identical unresolved finding repeats `3` cycles.
- Wake trigger retries remain capped (`2`) before fallback path.
- Blocked threads require orchestrator/human decision to continue.

Rationale:
- Prevents runaway ping-pong loops and trigger storms.
- Keeps compute/time use bounded while preserving recovery path.

Owner: Dante
Status: locked for MVP

### Q11. Resume vs Spawn Preference (Resolved 2026-02-17)
Question:
- For Codex CLI, when should wake logic force `resume` of prior session versus starting a fresh session with summarized context?

Decision:
- Prefer managed live trigger, then `resume`, then `spawn` by policy.

Decision detail:
- First preference: trigger active managed runtime (tmux).
- If runtime is not active, attempt `resume` up to `2` times.
- If resume fails twice, or session is stale (`>12h` heartbeat gap), spawn a fresh worker with thread summary context.
- If crash-loop pattern is detected (`>=3` failures in `15m`), skip resume and spawn directly.

Rationale:
- Preserves continuity when healthy; avoids stale/corrupt context when unhealthy.
- Provides deterministic fallback sequence for operational reliability.

Owner: Dante
Status: locked for MVP

## Decision Updates

### Q12. Managed Runtime Requirement (Resolved 2026-02-17)
Question:
- Do we require all agents to be launched under PTY supervisor control (`tmux`/ConPTY), or allow mixed managed/unmanaged operation in pilot?

Decision:
- Use hybrid participation with managed-runtime requirement for autonomous lanes.

Decision detail:
- Any agent that receives automated triggers must run as a managed runtime under supervisor control.
- Unmanaged sessions are allowed only for manual/ad-hoc interaction and carry no deterministic trigger SLA.
- If a target is unmanaged at trigger time, orchestrator must switch to `resume`/spawn-to-managed recovery path.

Rationale:
- Preserves reliability guarantees for autonomous orchestration.
- Still allows low-friction manual usage for personal workflows.

Owner: Dante
Status: locked for MVP

### Q13. Human Input Collision Policy (Resolved 2026-02-17)
Question:
- When operators type directly in an agent pane, how should trigger injection handle collisions (queue, defer, or override)?

Decision:
- Default to defer-and-queue; allow force override only with explicit operator intent.

Decision detail:
- Supervisor detects recent operator activity and marks runtime busy.
- Trigger injection is deferred with queue re-check every `5s`.
- Activity quiet window: `20s`; max defer window: `60s`.
- If still busy after max defer, fallback to `resume` path and emit collision audit event.
- After direct human intervention in worker pane, orchestrator sync prompt is required.

Rationale:
- Avoids corrupting active human input while keeping automation responsive.
- Keeps override behavior explicit and auditable.

Owner: Dante
Status: locked for MVP

## Remaining Open Questions
- None for current MVP baseline.
