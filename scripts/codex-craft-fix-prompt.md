Project: mc-ai-bot
Path: C:\Projects\mc-ai-bot
Minecraft: 1.21.1
Owner: NoSafeSky

Goal:
Fix crafting reliability regressions end-to-end with minimal deterministic changes.

Hard constraints:
1. Assistant-first only. No autonomous task progression.
2. Owner-only action authority.
3. Keep `assistantAutoExecute=false` and `goalAutonomy=false`.
4. `what next` must stay suggestion-only, execution only after explicit `yes`.
5. Every actionable command must end with terminal status success/fail/timeout/cancel.
6. No silent no-op behavior.

Primary targets:
1. Reproduce current craft failures from `memory/log.jsonl` first.
2. Fix root cause, not symptoms.
3. Keep recipe logic deterministic and non-hallucinatory.
4. Preserve required-tool compatibility for gather/mining.
5. Improve failure observability with explicit reason logs.

Execution workflow:
1. Inspect `memory/log.jsonl` and recent craft-related files:
   - `bot.js`
   - `brain/craft_executor.js`
   - `brain/dependency_planner.js`
   - `brain/acquisition_registry.js`
   - `brain/goal_compiler.js`
   - `brain/llm_plan.js`
2. Reproduce failure with tests or add a failing test first.
3. Implement minimal fix.
4. Add/adjust tests for the exact failure.
5. Run targeted tests, then `npm test`.
6. If tests still fail, continue until fixed or blocked.

Deliverables:
1. Exact files changed.
2. Why each change was needed.
3. Verification commands run and pass/fail results.
4. Remaining known risks, if any.

Important:
Do not add autonomous mission execution loops.
Do not broaden scope to unrelated refactors.
