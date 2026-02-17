# Operator Control Model (Explicit)

## 1. Decision
Primary control is centralized through one main orchestrator agent.

Meaning:
- Human operator talks to the orchestrator agent by default.
- Orchestrator delegates work to worker agents (`executioner`, `reviewer`, `security`, etc.).
- Worker agents are not the primary human interface during normal operations.

## 2. Roles
### Human Operator
- Sends goals, approvals, and corrections to orchestrator.
- Intervenes directly in worker panes only when needed.

### Orchestrator Agent (Primary Control Plane)
- Receives all primary instructions from human operator.
- Chooses target worker agent(s) and dispatches prompts/triggers.
- Tracks thread state, escalations, and completion.
- Reports consolidated status back to human operator.

### Worker Agents (Execution Plane)
- Perform scoped tasks based on orchestrator instructions.
- Post findings/results back to bridge threads.
- Remain observable and manually accessible in tmux panes.

## 3. Default Operating Pattern
1. Human -> orchestrator: high-level objective.
2. Orchestrator -> worker(s): task prompts and follow-up triggers.
3. Worker(s) -> bridge: outputs, findings, statuses.
4. Orchestrator -> human: summarized progress and decisions needed.

## 4. Manual Override Policy
Manual intervention is allowed and expected when required.

Allowed interventions:
- Human writes directly in worker pane for emergency correction or clarification.
- Human pauses/resumes trigger injection for a specific worker runtime.
- Human can force escalation and re-assign ownership through orchestrator.

Constraint:
- Even when manual override occurs, orchestrator remains source of workflow truth and should receive a synchronization update.

## 5. Why This Model
- Reduces cognitive load by giving one primary interaction endpoint.
- Preserves autonomy (orchestrator-driven delegation).
- Preserves control (human can directly intervene in worker panes).
- Improves auditability by consolidating workflow decisions through one control role.

## 6. Non-Goals
- Human manually prompting every worker as standard workflow.
- Removing manual override capability.
- Fully autonomous operation without human supervision.

## 7. Interface Implications
- Control CLI/API should optimize for orchestrator-first commands.
- Worker-targeted commands remain available but are secondary.

Example intent:
- Primary: `send instruction to orchestrator`
- Secondary: `send direct instruction to reviewer pane`

## 8. Sample Usage (End-to-End)
Scenario:
- Human wants to implement a feature with code quality and security checks.

Flow:
1. Human -> orchestrator:
- "Implement feature X and complete review/security checks."

2. Orchestrator -> executioner:
- "Implement feature X, run required tests, and report commit + change summary."

3. Executioner -> orchestrator:
- "Implementation done. Commit `<sha>`. Test results attached."

4. Orchestrator -> reviewer and security (parallel):
- Reviewer: "Review commit `<sha>` for correctness/regressions."
- Security: "Inspect commit `<sha>` for security risks and policy violations."

5. Reviewer/security -> orchestrator:
- Reviewer posts findings or approval.
- Security posts findings or approval.

6. Orchestrator decision:
- If any finding is open: send fix task back to executioner, then re-trigger reviewer/security as needed.
- If both are clear: build final consolidated report.

7. Orchestrator -> human:
- "Execution complete. Reviewer status: pass/fail. Security status: pass/fail. Remaining actions: ... "

Manual intervention rule:
- Human may directly message any worker pane at any step.
- After manual override, orchestrator must be updated so workflow state remains consistent.
