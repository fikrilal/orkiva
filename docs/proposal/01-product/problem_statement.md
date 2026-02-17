# Problem Statement

## Context
In multi-agent development workflows, one human often coordinates two or more isolated agent sessions:
- Session A: implementation/execution
- Session B: reviewer/quality gate
- Optional sessions: security, performance, release

Each session has useful context but cannot directly communicate with others. Human operators manually relay messages between them.

## Core Problem
The system lacks native cross-session communication.

Result:
- Human-mediated copy-paste becomes mandatory.
- Feedback loops become slower as agent count grows.
- Conversation history fragments across sessions.
- Important details can be lost, paraphrased incorrectly, or delayed.

## Symptoms
- Reviewer findings are copied manually into execution session.
- Fix completion updates are copied manually back to reviewer session.
- Re-review requests rely on manual reminders.
- Conversation quality drops because users compress context to save time.

## Impact
### Time Cost
- Every round trip adds manual coordination overhead.
- Review/fix/re-review cycles scale linearly with human attention, not agent throughput.

### Quality Cost
- Details can be dropped during relay (file paths, line references, risk severity).
- Higher chance of unresolved findings due to context mismatch.

### Cognitive Cost
- Human operator must track message state, ownership, and pending actions.
- Tooling feels less autonomous than expected from multi-agent workflows.

## Why Existing Workarounds Are Not Enough
### Plain Chat
- Chat can transmit intent but cannot reliably encode workflow state for automation.

### Structured Status Only
- Structured events are excellent for machine handling but cannot replace nuanced agent-to-agent reasoning.

### Shared PR Comments Alone
- Useful fallback, but limited when teams want private internal conversation, non-Git tasks, or fine-grained routing between many roles.

## Opportunity
A communication bridge can combine:
- human-like conversational messaging between agents
- structured metadata for routing, automation, and observability

This enables:
- less manual bridging
- faster and safer iteration cycles
- auditable, replayable conversation trails
- scalable coordination across two or more sessions

## Constraints
- Must support multiple concurrent threads and agents.
- Must preserve workspace isolation.
- Must prevent runaway agent loops.
- Must support incremental rollout (MVP to production).
- Must not require immediate redesign of existing agent runtime.

## Success Definition
The bridge is successful when:
- agents can communicate directly without human copy-paste in normal workflows
- review and re-review loops run end-to-end via the bridge
- chat remains natural while automation remains reliable
- operators can audit what happened and why
