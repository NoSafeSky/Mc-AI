## TODO (goal-driven autonomy + LLM)

- [x] Update config surface: epsilon (bandit), llmTimeoutMs, model name, safeMode flag, goalAutonomy toggle (default on)
- [x] Perception layer: snapshot lightweight world state (time/night, health/hunger, armor tier, nearby mobs/players, nearby blocks of interest, inventory key items)
- [x] Goal/heuristic layer: select goal (gather_wood, gather_stone, gather_iron, food, craft_basic, explore, follow_owner) from perception
- [x] Action set expansion: autonomous harvest/forage/craft/roam/follow-near/stalk/freeze/chat/idle; respect Safe mode controls (now removed)
- [ ] Bandit integration: persist policy.json, context = perception+goal, epsilon from config, feedback via rate good/bad, owner-only policy stat command
- [x] Command surface: keep existing commands; add goal on/off; stalk remains no-dig; LLM for all players; add harvest command
- [ ] Logging/observability: log perception snapshot, goal+action, policy updates, errors, Ollama/Gemini failures, kicks; startup dry-check
- [ ] Manual checks: owner commands, stopall/resume, autonomy ticks with/without safeMode, feedback updates policy.json