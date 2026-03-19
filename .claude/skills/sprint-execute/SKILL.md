---
name: sprint-execute
description: >
  Use when the user wants to execute an existing sprint document, implementation
  plan, or design doc — working through it phase-by-phase and checking off the
  Definition of Done. Also use when the user says "execute the sprint", "run the
  sprint", "start the next sprint", or points to a sprint document and asks you
  to build it. Pairs with the sprint-plan skill, which produces the sprints
  this skill executes. Do NOT use when the user wants to create or refine a
  sprint — use sprint-plan for that instead.
license: Apache-2.0
metadata:
  author: Justin McCarthy <justin@strongdm.com>
  version: "1.0"
---

# Sprint Execution

You are executing a structured sprint document. Your job is to work through
every phase and task methodically, validate your work against the Definition
of Done, and deliver a clean, verified result. **You may be running as Claude,
Codex, Gemini, or another agent** — this workflow is agent-agnostic.

## Input

$ARGUMENTS

## Step 0: Fetch Weather Report and Choose Strategy

### 0a. Fetch the current weather report

```bash
curl -sf https://factory.strongdm.ai/weather-report.md
```

Find the best current **coding model** from the report (look at rows like
CS/Math Hard Problems, Frontend Architecture, or any implementation-focused
entries). If the fetch fails, use these fallbacks:

| Agent | Fallback CLI |
|-------|-------------|
| Claude | `claude --dangerously-skip-permissions --model claude-opus-4-6 -p` |
| Codex | `codex --yolo --model gpt-5.3-codex --reasoning-effort high --full-auto exec` |
| Gemini | `gemini --yolo --model gemini-3.1-pro-preview-customtools --prompt` |


### 0b. Choose execution strategy

Ask the user which execution strategy to use via AskUserQuestion:

| Option | Label | Description |
|--------|-------|-------------|
| 1 | **Orchestrated** (Recommended) | You execute phase-by-phase with build/test validation after each phase — most thorough |
| 2 | **Delegate to Claude sub-agent** | Hand the entire sprint to a Claude sub-agent via the Task tool — faster, fresh context |
| 3 | **Delegate to Codex** | Hand the entire sprint to Codex CLI — alternative perspective |

Record the user's choice. You will use it in Step 4.

---

## Step 1: Find the Sprint

If the user provided a path, read it. Otherwise:

1. **Check the ledger** (if it exists):
   ```bash
   python3 scripts/ledger.py -d docs/sprints next
   ```
   Adjust the `-d` path if the project uses a different location.
2. Look for sprint documents in `docs/sprints/`, `docs/plans/`, or the project
   root. Find the lowest-numbered incomplete `SPRINT-*.md`.
3. If nothing is found, ask the user which sprint to execute.

Use TodoWrite to track progress through each step.

---

## Step 2: Read and Understand the Sprint

1. **Read the full sprint document** carefully.
2. **Read project conventions** — Look for `CLAUDE.md`, `AGENTS.md`,
   `README.md`, or equivalent guidance files.
3. **Inventory the work**:
   - Count the phases and tasks
   - Note the Definition of Done criteria
   - Identify dependencies between phases
   - Flag anything ambiguous or underspecified
4. **Create a TodoWrite checklist** from the sprint's phases and tasks.

---

## Step 3: Validate Preconditions

Before writing any code, verify:

- [ ] All dependencies listed in the sprint are satisfied
- [ ] You understand the project's build and test commands
- [ ] You understand the project's commit conventions

If any precondition is not met, stop and inform the user before proceeding.

---

## Step 4: Execute

How you execute depends on the strategy chosen in Step 0b.

### Strategy A: Orchestrated (phase-by-phase)

Work through each phase **in order**.

#### 4a. Read the phase requirements
- What files need to be created or modified?
- What is the expected behavior?

#### 4b. Implement
- Write the code or make the changes specified
- Follow the project's existing patterns and conventions
- If the sprint specifies exact file paths, use them
- If a task is ambiguous, make a reasonable choice and note it — do not stop
  to ask unless the ambiguity could lead to a wrong architectural decision

#### 4c. Validate after each phase
- **Build**: Run the project's build command. Fix errors before continuing.
- **Test**: Run the project's test suite. Fix failures before continuing.
- **Lint/format**: If the project has these tools, run them.

Do NOT proceed to the next phase with build or test failures.

#### 4d. Mark phase complete
- Update your TodoWrite checklist
- Commit the phase's work with a clear message
- On the first phase, mark the sprint as started:
  ```bash
  python3 scripts/ledger.py -d docs/sprints start NNN
  ```

### Strategy B: Delegate to Claude sub-agent

Use the **Task tool** with `subagent_type: "general-purpose"`. Choose the model
from the weather report (or let the user's Step 0b choice guide you).

Provide the sub-agent with a prompt that includes:
- The full contents of the sprint document (paste it into the prompt)
- The project conventions from `CLAUDE.md` / `AGENTS.md` (if they exist)
- These instructions:

```
You are implementing Sprint NNN. The sprint document below defines all
requirements.

Instructions:
1. Work through ALL items in the Definition of Done
2. Implement all required functionality per the sprint document
3. Run the project's build and test commands to validate
4. Fix any build or test failures
5. Ensure all validation passes per repo standards
6. Do NOT commit or push — the orchestrator will handle that

Sprint document:
[PASTE FULL SPRINT DOCUMENT HERE]
```

Wait for the sub-agent to complete, then verify by running the project's
build/test commands yourself. Fix anything the sub-agent missed.

Mark the sprint as started:
```bash
python3 scripts/ledger.py -d docs/sprints start NNN
```

### Strategy C: Delegate to Codex CLI

Run the Codex CLI using the command from the weather report (substitute NNN):

```bash
{codex_cli} "Please read docs/sprints/SPRINT-NNN.md — this is the sprint you
need to implement. Fully familiarize yourself with our project structure (see
CLAUDE.md if it exists) and any relevant existing code. Then work through ALL
items in the Definition of Done. Implement all required functionality per the
sprint document. Run the project's build and test commands to validate. Fix
any build or test failures. Do NOT commit or push — the orchestrator will
handle that."
```

Wait for Codex to complete, then verify by:
1. Reviewing the changes Codex made
2. Running the project's build/test commands yourself
3. Fixing any issues Codex left behind

Mark the sprint as started:
```bash
python3 scripts/ledger.py -d docs/sprints start NNN
```

---

## Step 5: Verify Definition of Done

Go through the sprint's **Definition of Done** item by item:

- Verify each criterion is actually satisfied (don't assume)
- Run the full test suite one final time
- If any criterion is not met, go back and fix it

---

## Step 6: Finalize

1. **Ensure all changes are committed** with meaningful messages.
2. **Mark the sprint completed**:
   ```bash
   python3 scripts/ledger.py -d docs/sprints complete NNN
   ```
3. **Summarize what was done**:
   - Which phases were completed
   - Any deviations from the sprint (and why)
   - Any ambiguities resolved (and how)
   - Any follow-up items discovered during implementation
4. **Present the summary to the user** for review.

---

## Handling Problems

### Build or test failure
Fix in the current phase. If the fix touches earlier phases, re-validate from
that point forward.

### Ambiguity in the sprint
Low-risk: make a reasonable choice and document it. High-risk (wrong
architectural direction): ask the user.

### Sprint is wrong or outdated
If the sprint conflicts with the actual codebase, stop and inform the user.
Propose an adjustment and get approval.

### Scope creep
Only implement what the sprint specifies. Note improvements as follow-up items
in your summary — do not implement them unless asked.
