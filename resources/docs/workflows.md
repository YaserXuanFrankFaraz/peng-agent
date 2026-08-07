# Workflows Markdown Guide

Craft Agent can visualize project workflows from Markdown files in your current session working directory.

## Location

Put workflow documents in the `workflow/` directory under the current session working directory:

```text
workflow/
  dev-pipeline.md
  ddl-change.md
```

If that directory is missing or contains no Markdown files, Craft Agent falls back to the app-level directory:

```text
~/.craft-agent/workflow/
```

Only first-level `*.md` files are read. Nested directories and `.markdown` files are ignored.

## Naming

The file name becomes the workflow id:

- `dev-pipeline.md` -> `dev-pipeline`
- `ddl-change.md` -> `ddl-change`

Use lowercase kebab-case names when possible.

## Recommended Template

```markdown
# Workflow: Human readable title (workflow-id)

> One-sentence summary of the workflow.

## Loop

Describe the repeated work this workflow standardizes.

## Trigger

- **Type**: manual
- **Method**: User describes the work and asks the agent to run this workflow.

## Identifier

- Use one stable slug for docs, branches, contracts, and review notes.
- Git branch: `feat/<slug>`.

## Phase Pipeline

### Phase 1 - Discovery

- **Input**: What the agent starts with.
- **Actions**:
  1. First key action.
  2. Second key action.
- **Outputs**: What this phase produces.

### Phase 2 - Contract CHECKPOINT

- **Input**: Discovery output.
- **Actions**:
  1. Prepare the decision-ready brief.
  2. Wait for approval.
- **Outputs**: Approved contract.
- **CHECKPOINT**: Approval is required before implementation.

## Test Gates

1. **Backend**: Run the affected backend tests.
2. **Frontend**: Run lint, type-check, and affected frontend tests.
3. **Integration**: Confirm the real response matches the contract.

## Definition of Done

- All declared test gates pass.
- Branches are pushed.
- Final brief is sent to the user.
```

## Runnable Workflows (Loop frontmatter)

A workflow becomes **runnable by the Loop engine** when the Markdown file starts
with a YAML frontmatter block whose first key is `loop: v1`. Files without the
marker stay plain documents: still viewable on the Workflows page and still
executable by an agent manually — just not startable as an automated run.

Minimal example:

```markdown
---
loop: v1
name: Human readable name
description: One-sentence summary
version: 1
trigger: { type: manual }
inputs:
  - { name: requirement, description: What the user provides, required: true }
strategy: { mode: sequential, onFailure: pause }
permissionMode: allow-all
agentNaming: { template: "my-flow · {stage}" }
stages:
  - id: stage-01
    name: Stage 1
    checkpoint: never          # always | never | conditional
    prompt: |
      What the stage subagent should do. {requirement} and other
      inputs/exported vars are interpolated by the engine.
  - id: stage-02
    name: Stage 2 (gate)
    checkpoint: always
    prompt: Produce the decision-ready brief; checkpointBrief is required.
---

# Workflow: Human readable title (my-flow)
(The Markdown body stays the human-readable spec, unchanged.)
```

Key fields (all others have sensible defaults):

- `inputs` — start-form declarations; `required: true` is validated at start.
  Values are interpolated into prompts as `{name}`.
- `stages[].checkpoint` — `always` intercepts after the stage completes;
  `conditional` intercepts only when the stage result sets
  `requestCheckpoint: true` (e.g. breaking-change gates); `never` passes through.
- `stages[].parallel` — child stages run concurrently; children inherit the
  parent's fields and each child must have its own `prompt`.
- `stages[].convergence.maxRounds` — how many fix-and-retry rounds the same
  session gets when `doneCriteria` are not yet met.
- `stages[].doneCriteria[]` — completion checks. With `check.command` the
  engine runs the command (exit 0 = met, e.g. test suites); without it the
  subagent self-reports via the result JSON's `criteria` map.
- `stages[].tools` / `stages[].repos` — **advisory only**: injected into the
  prompt as guidance, not enforced by the engine.
- `boundaries` — retry / token budget / time budget / rate-limit guards.
  Defaults: 3 consecutive failures, 2M tokens, 30m per stage, 4h per loop.
- `notifications` — brief granularity only. Channels and recipients are app
  configuration, never part of the workflow file.

Result contract: the engine appends instructions telling each stage subagent to
write a result JSON (`status` / `summary` / `criteria` / `vars` /
`requestCheckpoint` / `checkpointBrief`) under
`~/.craft-agent/loop/runs/<runId>/results/`. `vars` flow into later stages'
prompt interpolation.

**Stage idempotency requirement**: a run interrupted by an app restart resumes
by *re-running* the interrupted stage from scratch. Write stages so a re-run is
safe — produce files/branches that can be overwritten or re-created, and avoid
unrepeatable side effects outside the checkpointed gates.

## Pausing a run, and steering it by hand

A run can be paused instead of cancelled — cancelling is terminal and throws
away every completed stage, pausing keeps them.

- **Pause** holds at the next *stage boundary*: the current stage finishes, then
  the run stops before the next one starts. Nothing is lost or redone.
- **Pause now** stops the current turn but **keeps the stage's agent session
  alive**, so you can steer it and let it carry on.

While paused you can type **guidance** — plain instructions for the agent
("use bun, not npm", "skip the e2e suite", "read docs/x.md first"). On resume:

- **Resume with guidance** sends the guidance back into the *same* session with
  an explicit "carry on, do not start over" instruction, so the work already
  done in that stage stands.
- **Re-run this stage** starts a fresh session instead, with the guidance
  injected as a leading instruction.

Guidance is injected in full into every later attempt of the stage it was given
on, and later stages receive a short summary of it — so a correction like
"use bun, not npm" carries forward for the rest of the run. Approving a gate can
also carry a note, which attaches to the next stage.

Every intervention (pause / resume / guidance / approve / reject / skip) is
recorded against the run. When you later run **Improve this workflow**, the
design session is seeded with that history — recurring corrections, per-stage
attempt counts, pause reasons, and gate approve/reject ratios — so the fixes you
keep making by hand can be baked into the spec instead.

Because guidance is a *run-time* correction, it never edits the workflow file: a
run always executes the definition snapshot it started with.

## Visualization Rules

The Workflows page reads the Markdown and builds a read-only visual model:

- The first `#` heading becomes the workflow title.
- The first blockquote after the title becomes the summary.
- The `## Trigger` section becomes the trigger tile.
- `###` headings become phase cards.
- If no `###` headings exist, headings like `第一步`, `CHECKPOINT`, and `测试门禁` are used as phases.
- Text containing `CHECKPOINT`, `checkpoint`, `门禁`, `批准前`, or `等待批准` is shown as a gate.
- Text containing `只在`, `含破坏性`, `条件`, `breaking`, or `破坏性` is shown as a conditional gate.
- `## Test Gates`, `## 测试门禁`, or an automatic test phase with numbered items becomes the validation section.

## Tips

- Keep each phase short enough to fit on a card.
- Use bold labels such as `**Input**`, `**Actions**`, and `**Outputs**` for best parsing.
- Put decision points in explicit `CHECKPOINT` sections.
- Do not store secrets or live execution state in workflow docs; they are process specifications, not run logs.
