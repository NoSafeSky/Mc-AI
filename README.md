# mc-ai-bot

Assistant-first Minecraft bot for 1.21.1. The owner is the only action authority. The LLM interprets and plans; the deterministic executor performs validated steps.

## Core Contract
- No autonomous progression loop.
- No owner-confirm relaxation.
- No hidden gameplay fallback runner.
- Every actionable task ends `success`, `fail`, `timeout`, or `cancel`.
- Successful owner tasks say `Done!`.

## Command Model
- Owner commands can run without a prefix when `commandNoPrefixOwner=true`.
- Non-owner chat is conversational only.
- While busy, owner action commands queue FIFO when `assistantQueueEnabled=true`.
- `what next` is advisory only.
- `yes` executes only the currently suggested or confirmed task.
- `stopall` is the authoritative kill switch.

## Common Commands

| Example | Result | Notes |
|---|---|---|
| `craft me a wooden sword` | `craftItem` | Deterministic dependency plan, gather, craft, terminal result. |
| `craft me a stone sword` | `craftItem` | Reuses nearby stations and gathers prerequisites as needed. |
| `give me a wooden pickaxe` | `giveItem` | Gives from inventory only unless crafting was explicitly requested. |
| `dropall` | `dropAllItems` | Owner-gated inventory drop. |
| `drop inventory` | `dropAllItems` | Alias for `dropall`. |
| `what next` | `missionSuggest` | Suggests one next task, does not auto-execute. |
| `yes` | `missionAccept` or expand-search confirm | Executes only the pending accepted task. |
| `no` | `missionReject` or expand-search reject | Cancels the pending suggestion/decision. |
| `mission start` | `missionStart` | Starts advisory mission mode. |
| `let's beat minecraft` | advisory only | Must not auto-start a mission or task. |
| `bot status` | runtime status | Always returns `status`, `step`, `elapsed`, `state`, `heartbeat`, `kind`, and `msg`. |
| `bot lastfail` | last failure | Returns `code reason (next: ...)` when available. |
| `bot queue status` | queue status | Shows pending owner commands. |
| `bot queue clear` | queue clear | Clears queued owner commands. |
| `stopall` | hard stop | Stops active work, clears queue, responds explicitly. |

## Status and Failure Output
- `bot status` returns a single-line snapshot: `status`, `step`, `elapsed`, `state`, `heartbeat`, `kind`, `msg`.
- Pending expand-search decisions are surfaced in `bot status`.
- `bot lastfail` is explicit and actionable: `lastfail: <code> <reason> (next: <nextNeed>)`.

## Important Runtime Config
- `goalAutonomy=false`
- `assistantAutoExecute=false`
- `assistantRequireOwnerConfirm=true`
- `objectiveAutoStartPhrases=[]`
- `disableTimeouts=true`
- `leaderFollowerMode=true`
- `stationSearchRadius=32`
- `smeltTransferRetryLimit=10`
- `smeltInputTransferRetryLimit=6`
- `smeltNoStateChangeMs=40000`
- `gatherCandidateBanMs=15000`
- `gatherLogCandidateBanMs=45000`
- `gatherLogSameTreeFollowups=2`
- `gatherTreeFailLimit=2`
- `gatherDropRecoveryRetries=2`
- `gatherDropRecoverMoveTimeoutMs=2500`

## Cognitive Layer (Optional)
- `cognitiveEnabled=false` by default.
- New modules live under `brain/cognitive/`.
- Cognitive layer is wrapper-only:
  - no direct action execution
  - no owner-confirm bypass
  - no autonomy loop replacement
- It can:
  - observe world/social state on deterministic ticks
  - persist bounded cognitive memory in `memory/cognitive/`
  - adjust chat personality tone via `personalityModifier`
  - emit advisory suggestions with cooldown/rate limits

## Deterministic Gather / Smelt Notes
- Log gathering rejects unsafe stand positions and avoids same-tree reselection loops.
- Existing stations within 32 blocks are reused before placing new ones.
- Smelt transfer retries are bounded and fail explicitly with `smelt_transfer_failed` or `smelt_state_stalled`.
- Drop recovery is bounded and fails explicitly with `drop_recovery_failed`.

## Key Runtime Logs
- Routing and planning: `llm_route_result`, `llm_goal_compile_ok`, `llm_to_bot_intent`
- Gather selection and failure: `gather_target_selected`, `gather_target_reject`, `gather_dig_result`, `gather_drop_scan`, `gather_drop_recovery_failed`
- Stall and lifecycle: `task_start`, `task_success`, `task_fail`, `task_timeout`, `task_cancel`, `task_stall_fail`
- Queue and advisory mission: `queue_push`, `queue_pop`, `queue_clear`, `mission_start`, `mission_suggest`, `mission_accept`, `mission_reject`

## Tests

```bash
node --test test/craft_executor.test.js test/fuel_planner.test.js test/task_supervisor.test.js test/nlu.test.js
npm test
```
