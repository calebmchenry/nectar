# Garden Authoring Guide

This guide covers the core authoring rules that caused the first real-user failures in the pici pipeline.

## Shape Semantics

- `shape=box` (`codergen`): LLM/agent execution node.
  - Use `prompt="..."`.
  - Agent tool use is expected for filesystem/execution tasks.
- `shape=parallelogram` (`tool`): shell command node.
  - Use `tool_command="..."`.
- `shape=diamond` (`conditional`): deterministic edge router.
  - Do not use `prompt`.
  - Use edge `condition="..."` expressions to route.

## Core Attributes

- `prompt`: instruction text for `shape=box` nodes.
- `tool_command`: command string for `shape=parallelogram` nodes.
- `llm_model`: canonical model attribute for LLM nodes.
- `model`: alias for `llm_model` (`llm_model` takes precedence if both are set).
- `llm_provider`: provider override (`anthropic`, `openai`, `openai_compatible`, `gemini`, `simulation`).

## Shell Behavior (Important)

`tool_command` runs in a non-interactive shell.

- Shell aliases are not expanded.
- Use full commands and flags directly.
  - Example: `claude --dangerously-skip-permissions -p "..."` instead of relying on an alias.
- Runtime environment can differ from your interactive terminal.

Do not put secrets directly in `tool_command` values. Commands and failures are persisted in run artifacts.

## Post-Conditions with `assert_exists`

Use `assert_exists` to catch silent `exit 0` commands that produced no artifact.

Example:

```dot
draft [shape=parallelogram,
  tool_command="mkdir -p docs && echo '# Draft' > docs/draft.md",
  assert_exists="docs/draft.md"]
```

- Supports comma-separated paths.
- Paths are resolved relative to workspace root.
- Paths that escape workspace boundaries are rejected.

## Resuming Edited Graphs

If the garden changes after a run starts, resume will fail with a graph hash mismatch.

Resume anyway with:

```sh
nectar resume <run-id> --force
```
