# Manual Acceptance Checklist

Date: 2026-02-21
Environment: local Minecraft server + running bot

## Preconditions
- Bot is online and spawned.
- `config.owner` matches your Minecraft username.
- `commandNoPrefixOwner=true`.
- Optional: LLM API key configured (`GROQ_API_KEY` or provider-specific key).

## Core Scenarios

1. Owner command parsing and execution
- Send: `kill a pig`
- Expect: bot says `intent: attackMob pig (...)`
- Expect: bot pathfinds to nearby pig and attacks.

2. Casual owner chat should not execute action
- Send: `nice weather today`
- Expect: no task starts, no combat/path action.
- Expect: optional short chat reply only.

3. Non-owner cannot control bot
- From non-owner account send: `kill a pig`
- Expect: no action execution.
- Expect: log contains `intent_reject` with reason `not_owner`.

4. Deterministic parser works without LLM
- Temporarily unset LLM key or block API.
- Send: `attack zombie`
- Expect: command still executes via rules parser.

5. Unsupported freeform when LLM unavailable
- With LLM unavailable, send: `build me a castle`
- Expect: rejection `can't: unsupported request`.
- Expect: log contains `llm_unavailable`.

6. Ambiguous target rejection
- Send: `kill it`
- Expect: rejection `can't: specify mob target`.
- Expect: no attack task starts.

7. Cancel-on-new-command behavior
- Send long-running command: `explore`
- Immediately send: `come here`
- Expect: previous task canceled.
- Expect: new command starts and bot comes to owner.
- Expect: `task_cancel` logged for replaced task.

8. Stop/resume behavior
- Send: `stop everything`
- Expect: movement and current task stop.
- Send: `resume`
- Expect: bot accepts new commands again.

9. Strict target matching (pig vs piglin)
- Keep only piglin nearby (no pig in range).
- Send: `kill a pig`
- Expect: reject with `can't: no pig nearby (within X)`.
- Expect: bot does not attack piglin.

10. Living entity debug visibility
- Send: `bot entities`
- Expect: output includes living entities with type, e.g. `pig(animal)`, `zombie(hostile)`.
- Expect: not limited to old `type=mob` only.

11. Deterministic craft request
- Send: `craft me a wooden sword`
- Expect: structured intent ack `craftItem wooden_sword x1`.
- Expect: bot gathers/crafts dependencies and keeps item in inventory.

12. Quantity craft request
- Send: `make 2 stone pickaxes`
- Expect: bot plans stone-tier dependencies (sticks + cobblestone + table).
- Expect: either success with 2 pickaxes or explicit missing-step failure.

13. Unsupported acquisition rejection
- Send: `craft me a netherite sword`
- Expect: explicit failure with reason/next step (unsupported acquisition path).
- Expect: no silent no-op.

## More Complex Freeform Scenarios

14. Multi-step craft chain from near-empty inventory
- Clear inventory of sticks/planks/tools if possible.
- Send: `craft me a stone sword`
- Expect: bot executes dependency chain (logs -> planks -> sticks -> wooden pickaxe -> cobblestone -> stone sword).
- Expect: result is success or explicit `next` requirement, never silent.

15. Craft with explicit quantity and dependency expansion
- Send: `make 3 stone axes`
- Expect: bot computes enough sticks/cobblestone and repeats craft steps.
- Expect: either completion with 3 axes or clear fail reason naming missing dependency.

16. Complex request with polite language noise
- Send: `please craft me a wooden shovel now`
- Expect: parser still resolves to `craftItem wooden_shovel x1`.
- Expect: normal deterministic craft flow.

17. Unsupported complex build request fallback
- Send: `craft me a castle gate`
- Expect: reject as unsupported craft item, with clear message.
- Expect: no accidental freeform execution of unrelated actions.

18. Craft interruption by higher-priority command
- Send: `make 2 stone pickaxes`
- During execution send: `come here`
- Expect: craft task cancels quickly.
- Expect: bot starts `come` task immediately.
- Expect: logs include cancel for prior craft task.

19. Craft timeout behavior
- Put bot where required resources are unreachable.
- Send: `craft me a stone pickaxe`
- Expect: timeout/fail message includes reason and `next` guidance.
- Expect: no infinite loop.

20. Craft table placement path
- Ensure no nearby crafting table block.
- Send: `craft me a wooden sword`
- Expect: bot crafts/uses crafting table when needed (if `craftAutoPlaceTable=true`).
- Expect: craft continues after table placement.

21. Inventory retention after craft
- Send: `craft me a wooden sword`
- After success, inspect inventory.
- Expect: item remains in bot inventory by default (not auto-dropped).

22. Craft observability logs
- Run any successful craft and any failed craft.
- Expect logs include: `craft_job_start`, `craft_plan_built`, `craft_step_start`, `craft_step_ok`.
- On failures expect: `craft_step_fail` and `craft_job_fail` (or `craft_job_timeout`).

## Basic Intelligence v1 (Placement + Self-Correction)

23. Reposition before crafting-table placement
- Put the bot in a tight spot and send: `craft me a stone sword`.
- Expect bot to move to a nearby valid stand position before placing the table.
- Expect reasoner logs: `reasoner_candidate_pick`, `reasoner_reposition`.

24. Placement blocked by player/entity
- Stand where the bot would likely place a table and send: `craft me a wooden sword`.
- Expect bot to choose another nearby placement candidate instead of failing immediately.

25. No valid local placement candidate
- Surround the area so table placement is impossible within local rings.
- Send: `craft me a wooden sword`.
- Expect explicit failure like `can't: craft wooden_sword: failed to place crafting table (next: clear placement space near bot)`.
- Expect reasoner give-up log: `reasoner_step_giveup`.

26. Recoverable gather/mine retries
- Create temporary pathing obstruction while bot gathers logs or mines cobblestone.
- Send: `craft me a stone sword`.
- Expect bounded retries with local reposition attempts before final failure/success.
- Expect reasoner retry logs: `reasoner_try`, `reasoner_step_recover`.

27. Rollback switch check
- Set `reasoningEnabled=false` in config and restart bot.
- Send a craft command requiring table placement.
- Expect old direct behavior path (no `reasoner_*` logs).
- Set `reasoningEnabled=true` again for normal operation.

## Basic Intelligence v2 (Goal Decomposition + Dynamic Craft Intent)

28. Dynamic craft target parsing
- Send: `craft me an iron sword`.
- Expect structured intent ack `craftItem iron_sword x1 (...)`.
- Expect deterministic plan attempt (not ignored as unsupported tier v1).

29. Unknown craft target rejection
- Send: `craft me a banana sword`.
- Expect immediate rejection `can't: unknown craft target`.
- Expect log `intent_reject` with reason `unknown_craft_target`.

30. Inventory-first dependency behavior
- Ensure inventory has required stone-sword deps (stick + stone-material + crafting table item).
- Send: `craft me a stone sword`.
- Expect no unnecessary log gathering steps before craft.

31. Goal preview debug: needs
- Send: `bot needs` after a craft intent was parsed.
- Expect unresolved dependency preview list or `needs: none`.

32. Goal preview debug: plan
- Send: `bot plan` after a craft intent was parsed.
- Expect current step queue summary (action + item/station) or `plan: none`.

## Basic Intelligence v3 (Material Equivalence + Confirmed Recovery)

33. Wood variant lock removed for wooden sword
- Ensure nearby trees are not acacia.
- Send: `craft me a wooden sword`.
- Expect no forced `acacia_*` requirement in plan/logs.
- Expect plan needs use family item (`planks`) and craft continues.

34. Inventory-equivalent wood use
- Put `oak_planks` and `stick` in bot inventory.
- Send: `craft me a wooden sword`.
- Expect no log gather step; sword crafts directly from existing inventory.

35. Birch log converts through family planning
- Give bot `birch_log` only.
- Send: `craft me a wooden sword`.
- Expect plan decomposes through `log -> planks -> sword` (not species-locked gather).

36. Recipe question remains answer-only
- Send: `how to craft a mace`.
- Expect deterministic recipe answer only.
- Expect no task start/action execution.

37. Confirm-before-expand on missing resource
- Put bot where no cobblestone is within current gather rings.
- Send: `craft me a stone sword`.
- Expect prompt: `can't find <item> within <from>. expand to <to> and continue? (yes/no)`.
- Expect log `confirm_expand_search_prompt`.

38. Confirm flow: yes resumes with expanded radius
- After scenario 37, send: `yes`.
- Expect log `confirm_expand_search_yes`.
- Expect craft task restarts and uses expanded gather radius override.

39. Confirm flow: no/timeout cancels expansion
- After prompt, send `no` (or wait for timeout).
- Expect no resume task.
- Expect log `confirm_expand_search_no` or `confirm_expand_search_timeout`.

## Basic Intelligence v4 (Full Recipe DB + Stations + Auto-Relocate)

40. Planner budget no longer times out on simple weapon craft
- Send: `craft me a wooden sword`.
- Expect no `dependency planner timeout`.
- Expect `planner_budget_start` and `goal_plan_built` in logs.

41. LLM invalid craft target hard reject
- Send: `craft me a banana sword`.
- Expect immediate `can't: unknown craft target` or `can't: unsupported craft target`.
- Expect no task execution start for fake item.

42. Smelt chain planning present for smelted outputs
- Send: `craft me an iron sword`.
- Expect plan contains `smelt_recipe` and `ensure_station` when ore/raw materials are needed.
- Expect `station_step_start` and `fuel_plan_start` logs when smelting starts.

43. Auto-relocate for missing resources (no yes/no prompt)
- Keep bot in area with no logs/stone in current rings.
- Send: `craft me a stone sword`.
- Expect relocation attempts automatically (no owner confirmation gate).
- Expect logs: `relocate_start` then `relocate_ok` or `relocate_fail`.

44. Relocation bounded by configured limit
- Keep resource unavailable even after movement.
- Send: `craft me a stone sword`.
- Expect explicit terminal fail after bounded attempts.
- Expect no infinite loop and terminal `task_fail` with reason.

45. Station placement fallback (non-crafting-table station)
- Put a furnace item in inventory and no furnace nearby.
- Trigger a smelt step.
- Expect bot attempts to place station in valid nearby spot.
- Expect station logs: `station_step_start`, `station_step_ok` (or explicit fail reason).

46. Stick recipe avoids bamboo-first path by default
- World has bamboo and logs.
- Send: `craft me a stone sword`.
- Expect bot does not force bamboo stick recipe unless it is the only viable route.

47. Recipe Q&A aligns with deterministic executor variants
- Send: `how to craft a stone sword`.
- Expect deterministic variant answer with station/ingredients.
- Expect answer choice aligns with overworld-safe policy when inventory is empty.

## Debug Commands (owner with prefix)
- `bot entities`
- `bot where`
- `bot dist`
- `bot rawtypes`

## Pass Criteria
- All 47 scenarios behave as expected.
- No unhandled exceptions in console.
- Logs include `intent_decision`, `task_start`, and success/failure outcomes.
