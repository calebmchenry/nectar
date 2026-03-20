# Sprint 002 Draft — Claude

## Title: Complete Attractor Core Engine

## Strategy
Focus on completing all attractor spec engine features that don't require external LLM calls. This includes the remaining handlers (codergen in simulation mode, conditional, wait.human with auto-approve), goal gate enforcement, failure routing, expanded validation rules, proper outcome statuses, and the run directory structure. Parallel/fan-in/manager loop deferred to Sprint 003.

## Phases

### Phase 1: Fix Existing Issues & Foundation (15%)
- Fix parse test (compliance-loop.dot node count: 14 not 13)
- Fix engine test timeout
- Add PARTIAL_SUCCESS, RETRY, SKIPPED outcome statuses
- Update retry logic to handle RETRY status
- Add allow_partial node attribute
- Update backoff: initial_delay=200ms, jitter via random(0.5, 1.5), max_delay=60s

### Phase 2: New Handlers (30%)
- Codergen handler (box shape) with simulation mode (no backend = returns simulated response)
- $goal variable expansion in prompts
- Write prompt.md, response.md, status.json to stage directory
- Conditional handler (diamond) — pass-through returning SUCCESS
- Wait.human handler (hexagon) with AutoApproveInterviewer
- Interviewer interface + AutoApprove + QueueInterviewer (for testing)
- Accelerator key parsing from edge labels

### Phase 3: Goal Gates & Failure Routing (20%)
- Goal gate enforcement at terminal nodes
- retry_target / fallback_retry_target routing chain
- Graph-level retry_target and fallback_retry_target
- Update engine loop to check goal gates before exit

### Phase 4: Validation & Transforms (20%)
- start_no_incoming, exit_no_outgoing rules
- reachability rule (BFS from start)
- type_known, fidelity_valid (warnings)
- retry_target_exists, goal_gate_has_retry (warnings)
- prompt_on_llm_nodes (warning)
- Variable expansion AST transform ($goal)
- Transform pipeline: parse → transform → validate

### Phase 5: Run Directory & Status Files (15%)
- Per-node directory: {logs_root}/{node_id}/
- status.json written after each node
- prompt.md, response.md for codergen nodes
- auto_status attribute support
- Context namespace conventions (graph.goal mirrored)

## Definition of Done
- All existing tests pass (including updated compliance-loop tests)
- Codergen nodes in simulation mode write prompt.md + response.md + status.json
- Conditional nodes route based on edge conditions
- Wait.human with AutoApprove selects first option
- Goal gates block exit when unsatisfied
- retry_target routing works
- 8+ new validation rules pass
- $goal expansion works in prompts
- npm run build && npm test passes
