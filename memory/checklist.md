# Main Directive Checklist (Assistant-First)

Date: 2026-02-25
Owner: `NoSafeSky`
Directive: Bot is assistant, not autonomous runner.

## 1) Hard Rules (Must Always Hold)
- Bot executes actions only from owner command or explicit owner approval (`yes`/`mission accept`).
- Mission system is advisory only.
- No autonomous progression loop.
- Deterministic executor is final authority.
- Every actionable task ends with terminal status:
  `success | fail | timeout | cancel`.
- No silent no-op behavior.

## 2) Required Runtime Config
- `assistantModeEnabled=true`
- `assistantMissionAdvisory=true`
- `assistantAutoExecute=false`
- `assistantRequireOwnerConfirm=true`
- `assistantQueueEnabled=true`
- `assistantQueuePolicy=fifo`
- `goalAutonomy=false`
- `objectiveAutoStartPhrases=[]` (disables phrase auto-start)
- `leaderFollowerMode=true` (idle follow only)

## 3) Command Flow Validation
1. `hi`
- Expect chat reply only.

2. `let's beat minecraft`
- Expect no phrase auto-start (since auto-start phrases are disabled).

3. `mission start`
- Expect mission starts in assistant mode and suggests one next task.

4. `what next`
- Expect suggestion only (no execution).

5. `yes`
- Expect only suggested task executes.

6. `no`
- Expect suggestion rejected, nothing executes.

## 4) Craft Reliability Validation
1. `craft me a wooden sword`
- Expect deterministic dependency flow from empty/low inventory.

2. `craft me a stone sword`
- Expect prerequisite acquisition (tools/table/materials) and explicit failure reason if blocked.

3. Missing resource scenario
- Expect explicit reason + next need (no vague fail).

4. Recipe probe resilience
- Expect bounded retries and clear craft diagnostics before `recipe_unavailable`.

## 5) Safety + Control Validation
1. Non-owner actionable command
- Expect no execution.

2. `stop` during active task
- Expect task cancellation with terminal state.

3. Queue checks
- `bot queue status`
- `bot queue clear`
- Expect FIFO behavior and explicit queue logs.

## 6) Idle Follow Validation
1. While idle and owner online
- Expect movement-only owner follow (`leaderFollowerMode=true`).

2. While task is active
- Expect idle follow paused, task control takes priority.

3. After task terminal state
- Expect idle follow re-engages automatically.

## 7) Logs to Verify
- Mission: `mission_start`, `mission_suggest`, `mission_accept`, `mission_reject`, `mission_suggest_timeout`
- Craft: `craft_recipe_probe`, `craft_recipe_missing_ingredients`, `craft_recipe_retry`, `craft_recipe_fail_detail`
- Queue: `queue_push`, `queue_pop`, `queue_drop_full`, `queue_clear`
- Idle follow: `idle_follow_engaged`, `idle_follow_paused`
- Terminal: `task_success | task_fail | task_timeout | task_cancel`

## 8) Release Gate (Pass/Fail)
- Pass only if all hold:
  - No autonomous mission execution.
  - Owner-only action authority enforced.
  - `what next` stays advisory until explicit `yes`.
  - Craft tasks return reliable terminal outcomes with explicit reasons.
  - Idle follow is present only as movement stance, not autonomous progression.
