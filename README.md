# mc-ai-bot

Minecraft bot with hybrid natural-language command understanding.

## Current Command Model
- Action authority: `owner` only (`config.owner`).
- Owner command trigger: no prefix required when `commandNoPrefixOwner=true`.
- Non-owner messages: chat only, no action execution.
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
| `how to craft a mace` | Recipe Q&A (no action task) | Deterministic recipe answer from `minecraft-data`. |
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
- Unsupported craft requests (e.g. iron-tier) are rejected with explicit next need.
- Missing nearby targets produce specific errors like `can't: no pig nearby`.
- Missing craft resources can trigger confirmation prompt (`expand search ... yes/no`) when `missingResourcePolicy="ask_before_move"`.
- Target matching is exact-first; `pig` will not match `piglin`.

## Structured Acknowledgment
When `structuredAck=true`, the bot confirms parsed intent before execution.

Example:
- Input: `kill a pig`
- Ack: `intent: attackMob pig (rules)`

## Important Config Keys
- `commandNoPrefixOwner`
- `intentConfidenceThreshold`
- `structuredAck`
- `recipeQuestionMode`
- `recipeQuestionNoAction`
- `recipeVariantPolicy`
- `materialFlexPolicy`
- `preferBambooForSticks`
- `strictHarvestToolGate`
- `autoAcquireRequiredTools`
- `missingResourcePolicy`
- `missingResourceConfirmTimeoutSec`
- `missingResourceExpandedRadius`
- `dynamicMoveTimeoutBaseMs`
- `dynamicMoveTimeoutPerBlockMs`
- `ollamaDisableThinking`
- `ollamaRequestMode`
- `taskTimeoutSec`
- `maxTaskDistance`
- `noTargetTimeoutSec`
- `craftJobTimeoutSec`
- `craftGatherRadius`
- `craftAutoPlaceTable`
- `craftDefaultCount`
- `cancelOnNewCommand`

## Ollama Qwen3 Reliability Note
- For `qwen3:*` on Ollama, set `ollamaDisableThinking=true` and `ollamaRequestMode="stable"` so the bot receives final `response` text instead of thinking-only output.
- If LLM replies fail, verify Ollama is reachable at `http://127.0.0.1:11434`.

## Tests
Run:

```bash
npm test
```

Includes parser and LLM validation tests in `test/*.test.js`.
