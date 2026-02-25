# mc-ai-bot

Minecraft bot with hybrid natural-language command understanding.

## Current Command Model
- Action authority: `owner` only (`config.owner`).
- Owner command trigger: no prefix required when `commandNoPrefixOwner=true`.
- Routing: owner prompts go through LLM first when `llmRouteAllOwnerPrompts=true`.
- Non-owner messages: chat only, no action execution.
- While a task is running, new commands are ignored; use `stop`/`stopall` to interrupt.
- Safety model: constrained supported actions with time/distance limits.
- Living target detection: `animal`, `hostile`, `passive`, `water_creature`, `ambient`, `living`, `mob` (non-player only).

## Natural Language Command Table

| Example phrase | Parsed intent | Notes |
|---|---|---|
| `kill a pig` | `attackMob` + `mobType=pig` | Canonicalizes mob aliases where possible. |
| `attack zombie` | `attackMob` + `mobType=zombie` | Works with explicit combat verbs. |
| `kill hostile mobs` | `attackHostile` | Targets known hostile set. |
| `hunt food` | `huntFood` | Targets passive food mobs. |
| `follow me` | `follow` + `target=owner` | Stays following owner. |
| `come here` | `come` + `target=owner` | Attempts to move to owner. |
| `harvest wood` | `harvest` | Collects nearby logs. |
| `craft me a wooden sword` | `craftItem` + `item=wooden_sword` + `count=1` | Deterministic craft plan with dependencies. |
| `make 2 stone pickaxes` | `craftItem` + `item=stone_pickaxe` + `count=2` | Auto-gathers/crafts prerequisites within limits. |
| `how to craft a mace` | Chat reply (no action task) | Routed through LLM chat path, no command execution. |
| `craft basic tools` | `craftBasic` | Legacy best-effort basic crafting path. |
| `explore` | `explore` | Moves to random point within explore radius. |
| `stop` | `stop` | Stops pathing and movement. |
| `stop everything` | `stopall` | Hard stop. |
| `resume` | `resume` | Clears stopped state. |
| `be creepy` | `setCreepy=true` | Toggles creepy/autonomy mode flag. |
| `be normal` | `setCreepy=false` | Turns creepy mode off. |

## Unsupported / Ambiguous Requests
- Ambiguous combat like `kill it` is rejected with `can't: specify mob target`.
- Unsupported tasks are rejected with `can't: unsupported request`.
- Unsupported craft/acquisition chains are rejected with explicit next need.
- Missing nearby targets produce specific errors like `can't: no pig nearby`.
- Missing craft resources auto-relocate by default when `missingResourcePolicy="auto_relocate"`.
- Optional confirmation prompt (`expand search ... yes/no`) is still available with `missingResourcePolicy="ask_before_move"`.
- Target matching is exact-first; `pig` will not match `piglin`.

## Structured Acknowledgment
When `structuredAck=true`, the bot confirms parsed intent before execution.

Example:
- Input: `kill a pig`
- Ack: `intent: attackMob pig (rules)`

## Important Config Keys
- `commandNoPrefixOwner`
- `intentConfidenceThreshold`
- `llmPrimaryRouting`
- `llmRouteAllOwnerPrompts`
- `llmRouteNonOwnerChat`
- `llmPlanMode`
- `llmActionMinConfidence`
- `llmChatMinConfidence`
- `llmPlanMaxGoals`
- `llmRequireStrictJson`
- `llmPlanTimeoutMs`
- `structuredAck`
- `recipeQuestionMode`
- `recipeQuestionNoAction`
- `recipeVariantPolicy`
- `materialFlexPolicy`
- `preferBambooForSticks`
- `strictHarvestToolGate`
- `autoAcquireRequiredTools`
- `missingResourcePolicy`
- `missingResourceAutoRings`
- `missingResourceMaxRelocations`
- `missingResourceRelocateTimeoutSec`
- `missingResourceConfirmTimeoutSec`
- `missingResourceExpandedRadius`
- `recipeExecutionScope`
- `stationExecutionEnabled`
- `fuelPolicy`
- `dependencyPlanTimeoutMs`
- `dependencyMaxNodes`
- `recipePlannerBeamWidth`
- `recipeVariantCapPerItem`
- `dynamicMoveTimeoutBaseMs`
- `dynamicMoveTimeoutPerBlockMs`
- `ollamaDisableThinking`
- `ollamaRequestMode`
- `logCompactMode`
- `logMuteEvents`
- `taskTimeoutSec`
- `maxTaskDistance`
- `noTargetTimeoutSec`
- `craftJobTimeoutSec`
- `craftGatherRadius`
- `gatherBlockSampleCount`
- `gatherTargetCandidates`
- `gatherTargetFailLimit`
- `craftAutoPlaceTable`
- `craftDefaultCount`

## Key Runtime Logs
- LLM routing: `llm_route_start`, `llm_route_result`, `llm_goal_compile_ok`, `llm_goal_compile_fail`, `llm_to_bot_intent`
- Craft mining/tool compatibility: `gather_target_selected`, `gather_tool_check`, `gather_tool_auto_acquire`, `gather_tool_equip`, `gather_dig_start`, `gather_dig_result`, `gather_tool_missing`, `gather_tool_incompatible`
- Block perception/debug: `gather_scan_none` (includes nearby block summary when no target matched), `gather_target_reject` (tracks blocked/failed target attempts)
- Task lifecycle: `task_start`, `task_success`, `task_fail`, `task_timeout`, `task_cancel`
- Busy-command handling: `command_ignored_busy`

## Ollama Qwen3 Reliability Note
- For `qwen3:*` on Ollama, set `ollamaDisableThinking=true` and `ollamaRequestMode="stable"` so the bot receives final `response` text instead of thinking-only output.
- If LLM replies fail, verify Ollama is reachable at `http://127.0.0.1:11434`.

## Tests
Run:

```bash
npm test
```

Includes parser and LLM validation tests in `test/*.test.js`.
