# Security, Safety, and Governance

## 1. Security Objectives
- Only authorized agents can access allowed threads.
- Message contents and metadata are protected in transit and at rest.
- All sensitive operations are auditable.
- Abuse patterns (spam, loops, escalation bypass) are detected and contained.

## 2. Threat Model (Initial)
### Threats
- Unauthorized session impersonation.
- Cross-workspace data leakage.
- Prompt injection through untrusted message content.
- Runaway agent loops causing operational overload.
- Sensitive data persistence in logs.

### Mitigations
- Strong agent authentication and signed session claims.
- Strict workspace/thread ACL checks on every call.
- Personal MVP: operator-managed content hygiene; automated filtering/redaction deferred.
- Loop/rate controls plus escalation thresholds.
- Structured audit logging with controlled retention.

## 3. Authentication and Authorization
## 3.1 Authentication
- Every MCP call must carry authenticated caller identity.
- Identity must be platform-issued and signed (short-lived token).
- Runtime-provided raw `agent_id` values are never trusted as source of truth.

Token claim baseline:
- `agent_id`
- `workspace_id`
- `role`
- `session_id`
- `iat`
- `exp`
- `jti`

## 3.2 Authorization
- Access policy checks at thread and message operations.
- Authorization decisions use verified token claims.
- Role-based permissions:
  - `participant`: read/write thread messages
  - `coordinator`: manage participants and thread state
  - `auditor`: read-only access to audit records

## 3.3 Least Privilege
- Agent sessions should receive minimum role needed.
- Elevated operations (participant management, force-close) require coordinator role.

## 3.4 Token Lifecycle
- Tokens are short-lived and rotated automatically.
- Revocation must be supported for compromised runtimes or policy violations.
- Expired/invalid/revoked tokens fail with `UNAUTHORIZED`.

## 3.5 Workspace Boundary Enforcement
- MVP operates in a single-workspace trust domain.
- Token `workspace_id` must match thread/workspace scope on every call.
- Cross-workspace routing attempts must be rejected and audited.

## 4. Data Protection
## 4.1 In Transit
- TLS required for all service traffic.

## 4.2 At Rest
- Encrypted storage for message and audit tables where available.
- Key rotation policy defined by platform owner.

## 4.3 Redaction
- Logs must avoid raw secrets and tokens.
- Personal MVP: no automated inline content redaction/filtering.
- Future enhancement: optional inline redaction for known sensitive patterns.

## 5. Safety Controls
## 5.1 Loop Detection
- Detect repeated back-and-forth patterns above threshold (example: >20 turns without state change).
- Auto-mark thread `blocked` and emit escalation event.

## 5.2 Rate Limits
- Per-agent and per-thread message rate limits.
- Burst allowances with cooldown windows.

## 5.3 Size Limits
- Max message body size.
- Max metadata object size.
- Attachment support deferred until explicit policy exists.

## 5.4 Conflict Handling
- If two agents attempt incompatible thread state changes, preserve first valid update and return `CONFLICT` for subsequent call.

## 6. Governance Model
## 6.1 Ownership
- Each thread has an owner agent or coordinator.
- Owner is accountable for closure criteria.

Conflict authority policy:
- Human operator is final authority for dispute overrides.
- Orchestrator has operational authority to block/reopen/escalate.
- Worker agents cannot force-close disputed threads.

## 6.2 Lifecycle Policy
- `active` -> `resolved` -> `closed`
- `active` -> `blocked` -> `active` or `closed`

## 6.3 Retention
- Personal MVP: indefinite retention (no automatic message expiry).
- Future enhancement: configurable retention by workspace tier and automated expiry.
- Audit events may eventually use separate retention policy from chat bodies.

## 6.4 Auditability
For each critical operation, store:
- caller identity
- operation name
- timestamp
- request ID
- affected resource IDs
- result (success/failure)

## 7. Incident Response Baseline
### Triggers
- repeated authorization failures
- abnormal message volume spikes
- frequent loop escalations
- data leakage detection from scanner

### Actions
- throttle or isolate impacted agent identity
- alert operator
- snapshot relevant thread/audit timeline
- require manual unlock for blocked critical threads

## 8. Compliance Considerations
- Data residency requirements may affect storage topology.
- Regulated environments may require stricter retention and immutable audit storage.
- Human override actions should be explicitly logged for accountability.

## 9. Security Acceptance Criteria
- Unauthorized thread access attempts are rejected and logged.
- Cross-workspace access tests fail as expected.
- Loop detection triggers under synthetic load tests.
- Audit logs can reconstruct a full review/fix/re-review incident timeline.
