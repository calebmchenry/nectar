---
name: sprint-plan
description: >
  Use when the user wants to plan a significant piece of work — a feature,
  sprint, milestone, or project — especially when requirements are ambiguous,
  the scope is non-trivial, or multiple valid approaches exist. Also use when
  the user says "megaplan", "plan a sprint", "help me plan", or asks for a
  structured planning workflow. Do NOT use for simple single-file changes,
  bug fixes with obvious solutions, or tasks the user has already fully specified.
license: Apache-2.0
metadata:
  author: Justin McCarthy <justin@strongdm.com>
  version: "1.0"
---

# Collaborative Multi-Agent Sprint Planning

You are orchestrating a planning workflow that produces high-quality sprint
documents through competitive ideation between Claude, Codex, and Gemini,
human interview, and synthesis. **You may be running as Claude, Codex, Gemini,
or another agent** — this workflow is agent-agnostic. You call out to all
three CLIs explicitly; you do not assume you are any one of them.

## Seed Prompt

$ARGUMENTS

## Workflow Overview

1. **Orient** — Understand the project, conventions, and recent work
2. **Intent** — Write a concentrated intent document as a shared brief
3. **Draft** — Launch Claude, Codex, and Gemini CLIs in parallel for independent drafts
4. **Cross-critique** — Each agent critiques the other two drafts
5. **Interview** — Clarify with the human (depth scales with uncertainty)
6. **Merge** — Synthesize the best ideas into a final sprint document

Use TodoWrite to track progress through each phase.

---

## Phase 0: Fetch Weather Report

Before starting, fetch the current weather report:

```bash
curl -sf https://factory.strongdm.ai/weather-report.md
```

Find the **Sprint Planning** row. It specifies the consensus operator models
and thinking-effort levels. If the fetch fails, use these fallbacks:

| Agent | Fallback CLI |
|-------|-------------|
| Claude | `claude --dangerously-skip-permissions --model claude-opus-4-6 --thinking-budget high -p` |
| Codex | `codex --yolo --model gpt-5.2 --reasoning-effort high --full-auto exec` |
| Gemini | `gemini --yolo --model gemini-3.1-pro-preview-customtools --prompt` |

The weather report's consensus operator — `consensus(opus-4.6, gpt-5.2, gemini-3.1-pro)` —
is implemented by this skill's workflow: independent parallel drafts from each
model, cross-critique, then an LLM merge of the strongest points from all three.
Use high thinking/reasoning effort for all planning calls.

Store the resolved CLI commands for use in Phases 3 and 4.

---

## Phase 1: Orient

**Goal**: Understand current project state and recent direction.

1. **Read project conventions** — Look for `CLAUDE.md`, `AGENTS.md`, `README.md`,
   or equivalent project-level guidance files.
2. **Review recent work** — Check git log, recent PRs, or sprint documents.
3. **Identify relevant code** — Search for modules, types, or patterns related
   to the seed prompt.
4. **Note constraints** — Architectural patterns, testing conventions, deployment
   requirements, or team norms.

### Deliverable

Write a brief **Orientation Summary** (3-5 bullet points) covering:
- Current project state relevant to the seed
- Recent work themes and direction
- Key modules/files likely involved
- Constraints or patterns to respect

---

## Phase 2: Intent

**Goal**: Create a concentrated intent document that both agents will use.

1. Create `docs/sprints/drafts/` (or wherever the project keeps sprint docs).
2. Write the intent document to `SPRINT-NNN-INTENT.md`. See
   `references/intent-template.md` for the full template.

Must include: seed prompt, orientation summary, relevant codebase areas,
constraints, success criteria, verification strategy, uncertainty assessment
(Low/Medium/High for correctness, scope, architecture), open questions.

---

## Phase 3: Draft

**Goal**: Get independent drafts from Claude, Codex, and Gemini.

Launch **all three** CLI commands in parallel. Substitute `{INTENT}` with the path
to the intent document, and `{CLAUDE_DRAFT}` / `{CODEX_DRAFT}` / `{GEMINI_DRAFT}`
with output paths in the drafts directory:

**Claude CLI:**
```bash
{claude_cli} "Read {INTENT} and the project conventions. Write an independent
sprint draft to {CLAUDE_DRAFT}. Follow the sprint template structure: Overview,
Use Cases, Architecture, Implementation, Files Summary, Definition of Done,
Risks, Security, Dependencies, Open Questions."
```

**Codex CLI:**
```bash
{codex_cli} "Read {INTENT} and the project conventions. Write an independent
sprint draft to {CODEX_DRAFT}. Follow the sprint template structure: Overview,
Use Cases, Architecture, Implementation, Files Summary, Definition of Done,
Risks, Security, Dependencies, Open Questions."
```

**Gemini CLI:**
```bash
{gemini_cli} "Read {INTENT} and the project conventions. Write an independent
sprint draft to {GEMINI_DRAFT}. Follow the sprint template structure: Overview,
Use Cases, Architecture, Implementation, Files Summary, Definition of Done,
Risks, Security, Dependencies, Open Questions."
```

Wait for all three to complete, then read all drafts.

See `references/sprint-template.md` for the template structure.

---

## Phase 4: Cross-Critique

**Goal**: Each agent critiques the other two drafts.

Launch all three in parallel:

**Claude CLI:**
```bash
{claude_cli} "Read the sprint drafts at {CODEX_DRAFT} and {GEMINI_DRAFT}. Write
a critique to {CLAUDE_CRITIQUE}. Identify: strengths, weaknesses, gaps in risk
analysis, missing edge cases, and Definition of Done completeness for each draft."
```

**Codex CLI:**
```bash
{codex_cli} "Read the sprint drafts at {CLAUDE_DRAFT} and {GEMINI_DRAFT}. Write
a critique to {CODEX_CRITIQUE}. Identify: strengths, weaknesses, gaps in risk
analysis, missing edge cases, and Definition of Done completeness for each draft."
```

**Gemini CLI:**
```bash
{gemini_cli} "Read the sprint drafts at {CLAUDE_DRAFT} and {CODEX_DRAFT}. Write
a critique to {GEMINI_CRITIQUE}. Identify: strengths, weaknesses, gaps in risk
analysis, missing edge cases, and Definition of Done completeness for each draft."
```

Wait for all three, then read all critiques.

---

## Phase 5: Interview

**Goal**: Refine understanding through human dialogue, with depth proportional
to uncertainty.

### Assess Uncertainty

| Factor | Low | High |
|--------|-----|------|
| **Correctness** | Well-understood domain | Reference impl, spec compliance |
| **Scope** | Specific and bounded | Vague or ambitious |
| **Architecture** | Extends existing patterns | New patterns, integrations |

- **Low**: 1-2 questions
- **Medium**: 3-4 questions
- **High**: 5-7 questions

### Question Priority

1. **Verification Strategy** — "Is [X] sufficient for [domain]?"
2. **Scope Validation** — "I've included [X] but excluded [Y]. Right?"
3. **Priority / Trade-offs** — "What should we cut if constrained?"
4. **Technical Preferences** — "Any strong opinions on [choice]?"
5. **Sequencing** — "External dependencies or ordering constraints?"

### Conduct

Use AskUserQuestion iteratively. **Every question must include:**
- Substantive options
- "Skip - proceed to next phase" (always)

If the user skips, move immediately to Phase 6.

---

## Phase 6: Merge

**Goal**: Synthesize both drafts, both critiques, and interview feedback into a
final sprint document.

1. **Compare all three drafts** — architecture, phasing, risk identification,
   Definition of Done completeness.
2. **Assess each critique** — which criticisms are valid? What's defensible?
3. **Write merge notes** to `SPRINT-NNN-MERGE-NOTES.md`:
   - Claude draft strengths / Codex draft strengths / Gemini draft strengths
   - Valid critiques accepted / rejected (with reasoning)
   - Interview refinements applied
4. **Write the final sprint** to `docs/sprints/SPRINT-NNN.md`.
5. **Update the ledger**:
   ```bash
   python3 scripts/ledger.py -d docs/sprints sync
   ```
6. **Present to the user** for approval.

---

## File Structure

After completion:

```
docs/sprints/
├── drafts/
│   ├── SPRINT-NNN-INTENT.md
│   ├── SPRINT-NNN-CLAUDE-DRAFT.md
│   ├── SPRINT-NNN-CODEX-DRAFT.md
│   ├── SPRINT-NNN-GEMINI-DRAFT.md
│   ├── SPRINT-NNN-CLAUDE-CRITIQUE.md
│   ├── SPRINT-NNN-CODEX-CRITIQUE.md
│   ├── SPRINT-NNN-GEMINI-CRITIQUE.md
│   └── SPRINT-NNN-MERGE-NOTES.md
└── SPRINT-NNN.md
```

---

## Output Checklist

- [ ] Weather report fetched (or fallbacks set)
- [ ] Orientation summary complete
- [ ] Intent document written
- [ ] Claude draft received
- [ ] Codex draft received
- [ ] Gemini draft received
- [ ] Claude's critique received
- [ ] Codex's critique received
- [ ] Gemini's critique received
- [ ] Interview conducted (user may exit early)
- [ ] Merge notes written
- [ ] Final sprint document written
- [ ] Ledger updated
- [ ] User approved the final document
