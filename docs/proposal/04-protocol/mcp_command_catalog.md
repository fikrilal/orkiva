# MCP Command Catalog (MVP)

## 1. Purpose
Provide one authoritative list of MCP commands for implementation, testing, and operator reference.

Scope:
- External MCP commands exposed by `bridge-api`.
- Internal supervisor APIs are listed separately as non-MCP interfaces.

## 2. External MCP Commands (Locked for MVP)
Versioning rule:
- Expose all commands under `/v1`.
- Payloads include `schema_version` where defined in protocol.
- For `post_message` with `kind=event`, payload metadata includes `event_version` (default-normalized to `1` when omitted for compatibility).

### 2.1 Thread Commands
1. `create_thread`
2. `get_thread`
3. `update_thread_status`
4. `summarize_thread`

### 2.2 Message Commands
1. `post_message`
2. `read_messages`
3. `ack_read`

### 2.3 Session and Wake Commands
1. `heartbeat_session`
2. `trigger_participant`

## 3. Command Status Matrix
| Command | MVP | Purpose |
|---|---|---|
| `create_thread` | Required | Create collaboration thread and participant set |
| `get_thread` | Required | Read thread metadata and participants |
| `post_message` | Required | Append chat/event message to thread |
| `read_messages` | Required | Read ordered stream after cursor |
| `ack_read` | Required | Update participant read checkpoint |
| `update_thread_status` | Required | Transition thread lifecycle status |
| `summarize_thread` | Required | Generate compact context summary |
| `heartbeat_session` | Required | Update runtime/session liveliness |
| `trigger_participant` | Required | Wake dormant participant via supervisor/fallback policy |

## 4. Non-MCP Internal Supervisor APIs (For Clarity)
These are not exposed as agent MCP commands:
1. `register_runtime`
2. `trigger_runtime`
3. `heartbeat_runtime`
4. `deregister_runtime`

They are internal APIs between orchestrator and supervisor worker.

## 5. Source of Truth
- Request/response contracts and error model:
  - `protocol_spec.md`
- Runtime trigger behavior and fallback chain:
  - `process_level_trigger_design.md`
  - `tmux_supervisor_implementation_spec.md`

## 6. Change Policy
- New MCP command requires:
  1. update this catalog
  2. update `protocol_spec.md`
  3. add backlog story and acceptance criteria
  4. add tests for success + error path
