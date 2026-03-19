# Weather Report

The weather report at `https://factory.strongdm.ai/weather-report.md` provides
current model recommendations. Skills fetch it at activation time and fall back
to baked-in defaults if unreachable.

## Format

The report is a markdown document with a table of use cases, preferred models,
parameters, and notes. Key rows for these skills:

| Use | Models (by preference) | Parameters | Notes |
|-----|------------------------|------------|-------|
| Sprint Planning | consensus(opus-4.6, gpt-5.2) | high / extra high | |
| CS/Math Hard Problems | gpt-5.3-codex | default | Best coding model |

## Consensus Operator

`consensus(model-a, model-b)` means: run both models independently, then merge
the strongest points from each into a single output. The sprint-plan skill
implements this via parallel drafts, cross-critique, and merge phases.

## Consumption

```bash
curl -sf https://factory.strongdm.ai/weather-report.md
```

Parse the markdown table to find the row matching your use case. Extract the
model names and parameters. Map them to CLI invocations:

- Claude: `claude --model {model} --thinking-budget high -p "{prompt}"`
- Codex: `codex --model {model} --reasoning-effort {effort} --full-auto exec "{prompt}"`

## Fallbacks

If the fetch fails, use:

| Skill | Agent | Fallback CLI |
|-------|-------|-------------|
| sprint-plan | Claude | `claude --model claude-opus-4-6 --thinking-budget high -p` |
| sprint-plan | Codex | `codex --model gpt-5.2 --reasoning-effort high --full-auto exec` |
| sprint-execute | Claude | `claude --model claude-opus-4-6 -p` |
| sprint-execute | Codex | `codex --model gpt-5.3-codex --reasoning-effort high --full-auto exec` |
