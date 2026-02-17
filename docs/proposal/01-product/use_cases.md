# Use Cases

## Personas
- Human Operator: configures agents and supervises escalations.
- Execution Agent: implements code changes.
- Reviewer Agent: reviews code and reports findings.
- Specialist Agent: security/performance/domain specialist.
- Coordinator Agent (optional): orchestrates and routes work.

## Primary Use Case: Executioner <-> Reviewer Loop
### Current
1. Operator asks reviewer session to inspect changes.
2. Reviewer posts findings.
3. Operator copies findings into execution session.
4. Execution agent fixes issues.
5. Operator copies fix status back to reviewer session.
6. Reviewer re-checks.

### Desired
1. Reviewer posts findings directly to a shared thread.
2. Execution agent receives message automatically.
3. Execution agent posts fix commit and status.
4. Reviewer auto-detects fix message and re-reviews.
5. Thread reaches terminal status (`resolved` or `needs_more_changes`).

## Use Case: Multi-Reviewer Parallel Review
1. Coordinator opens one thread with three recipients:
- reviewer-agent
- security-agent
- performance-agent
2. Each specialist posts findings independently.
3. Execution agent receives all findings in one thread.
4. Coordinator marks findings resolved as commits land.
5. Final summary generated for human approval.

## Use Case: Ad Hoc Chat Between Agents
1. Execution agent asks reviewer: "Is this refactor acceptable for boundary rules?"
2. Reviewer replies with rationale and alternatives.
3. Conversation remains attached to thread context.
4. Structured status remains optional for this exchange.

## Use Case: Re-Review Triggering
1. Finding exists with status `open`.
2. Execution agent posts `fix_pushed` message with commit SHA.
3. Bridge emits re-review signal to reviewer.
4. Reviewer returns `verified` or `rejected` with reasons.

## Use Case: Dormant Reviewer Wake-Up (Codex CLI)
1. Reviewer agent has finished prior task and is idle/offline.
2. New message is posted to a thread addressed to reviewer.
3. Bridge sees unread message and checks session registry.
4. Activation orchestrator runs `codex exec resume <session_id> <trigger_prompt>`.
5. Reviewer agent resumes same logical session and processes unread messages.
6. If resume target is unavailable, fallback spawn starts a new session with thread summary context.

## Use Case: Human-in-the-Loop Escalation
1. Agents disagree after N message turns.
2. Loop guard triggers escalation.
3. Human operator receives summary plus key message links.
4. Human decides and posts final instruction.

## Use Case: Cross-Task Continuity
1. Agent ends session unexpectedly.
2. New session instance joins same thread using identity token.
3. New instance loads last N messages and structured state.
4. Work continues without re-briefing from scratch.

## Detailed Scenario Example
### Scenario
A reviewer finds two issues in a feature PR.

### Thread Timeline
1. `reviewer` -> `executioner`
- Message: "Blocking issue: null handling in mapper."
- Metadata: severity `high`, file `lib/features/profile/data/mappers/user_mapper.dart`, line `42`.

2. `executioner` -> `reviewer`
- Message: "Patched null fallback and added unit test."
- Metadata: event `fix_pushed`, commit `abc1234`.

3. `reviewer` -> `executioner`
- Message: "Issue 1 verified. Issue 2 still failing localization fallback test."
- Metadata: issue_1 `resolved`, issue_2 `open`.

4. `executioner` -> `reviewer`
- Message: "Updated fallback logic and test assertions."
- Metadata: event `fix_pushed`, commit `def5678`.

5. `reviewer` -> thread
- Message: "All blocking findings resolved."
- Metadata: thread_status `resolved`.

## Non-Use Cases (Out of Scope Initially)
- Autonomous code changes across repositories without explicit thread policy.
- Unlimited open-ended agent swarm behavior.
- Replacing existing PR review systems entirely.
- Cross-organization data sharing in MVP.

## Acceptance Lens Per Use Case
For each use case above, success requires:
- no human copy-paste for normal flow
- full thread traceability
- deterministic ownership/routing
- clear thread end-state
