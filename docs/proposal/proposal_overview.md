# Orkiva Proposal

## Purpose
This folder contains a complete proposal for enabling direct communication between multiple coding-agent sessions (for example: executioner, reviewer, security reviewer, release coordinator) without manual copy-paste by a human operator.

The proposal assumes a chat-capable system, not only structured handoff events.

## Project Identity (Locked)
- Name: `Orkiva`
- Repo slug: `orkiva`
- Repo description: `MCP that connects AI agent sessions so they can coordinate work on their own.`

## Layout
- `docs/proposal/`: all proposal and implementation-planning documents, grouped by responsibility.

## Why This Exists
Current workflow friction:
- A human acts as a bridge between separate sessions.
- Findings and fixes are retyped or copied manually.
- Re-review cycles are delayed and error-prone.
- Context can drift between sessions.

This proposal introduces an MCP-based bridge with both:
- conversational thread messaging
- structured workflow metadata for automation
- dormant-agent wake mechanism for runtime reactivation

## Document Map
- `01-product/problem_statement.md`: problem framing, impact, constraints, and success rationale.
- `01-product/use_cases.md`: realistic usage patterns and interaction examples.
- `01-product/prd.md`: product requirements document (goals, requirements, KPIs, release scope).
- `02-architecture/operator_control_model.md`: operating model with orchestrator as primary control interface.
- `02-architecture/solution_architecture.md`: system design, components, data flow, and tradeoffs.
- `02-architecture/technical_stack_and_architecture.md`: locked implementation stack, runtime topology, and module boundaries.
- `02-architecture/system_tree_folder_structure.md`: concrete repository tree and folder responsibilities.
- `03-runtime/process_level_trigger_design.md`: process-level wake design and fallback behavior.
- `03-runtime/tmux_supervisor_implementation_spec.md`: concrete `tmux` command-level spec and failure state machine.
- `04-protocol/protocol_spec.md`: message/thread model and MCP tool contract.
- `04-protocol/mcp_command_catalog.md`: authoritative MVP MCP command list and governance.
- `05-security/security_and_governance.md`: auth, isolation, abuse prevention, and audit design.
- `06-operations/rollout_and_operations.md`: delivery phases, SLOs, tests, and runbooks.
- `06-operations/implementation_backlog.md`: epics/stories for execution.
- `07-decisions/open_questions.md`: decision register and resolved lock-ins.

## Reading Order
1. `01-product/problem_statement.md`
2. `01-product/use_cases.md`
3. `02-architecture/operator_control_model.md`
4. `01-product/prd.md`
5. `02-architecture/solution_architecture.md`
6. `03-runtime/process_level_trigger_design.md`
7. `03-runtime/tmux_supervisor_implementation_spec.md`
8. `04-protocol/protocol_spec.md`
9. `04-protocol/mcp_command_catalog.md`
10. `02-architecture/technical_stack_and_architecture.md`
11. `02-architecture/system_tree_folder_structure.md`
12. `05-security/security_and_governance.md`
13. `06-operations/rollout_and_operations.md`
14. `06-operations/implementation_backlog.md`
15. `07-decisions/open_questions.md`

## Intended Outcome
After review, this proposal should be detailed enough to:
- create implementation tickets
- align on architecture and governance
- build an MVP without redesigning core concepts
