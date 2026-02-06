# ExecPlans
When writing complex features or significant refactors, use an ExecPlan (as described in .agent/PLANS.md) from design to implementation.

## Planning rule (must follow for ExecPlans)
In the prose of Milestones / Plan of Work / Concrete Steps (not as repeated checklists), ensure each milestone/step clearly covers:

- the user-visible goal/outcome,
- the exact repo paths to edit (prefer existing codepaths),
- any Skills/Tools to use (only when helpful),
- the concrete validation (commands + expected outputs),
- the docs that must be updated alongside the code.

Do not use checklists/tables for narrative sections; only the Progress section uses checkbox lists, as required by .agent/PLANS.md.
If ambiguity exists, choose a safe default and record it in Decision Log; only ask the user if proceeding would be risky or irreversible.

# Working style
- Work in small, verifiable increments: plan → implement → validate → document.
- Prefer editing existing codepaths over creating parallel abstractions.
- If requirements are ambiguous, ask one focused question or propose 1–2 options, then proceed with the safest default.

# Code quality constraints (hard rules)
- Do NOT invent placeholder variables/structures. Reuse existing names and domain concepts; if a new name is required, make it specific and consistent.
- Do NOT keep backward-compatibility code or old logic unless explicitly required by the task or tests. Remove dead code when replacing behavior.
- Keep files small and single-responsibility:
  - If a file grows beyond ~1000 lines OR mixes responsibilities, split it (extract modules/components/helpers).
  - Prefer shallow, readable modules over one huge file.

# Validation
- After changes, run the most relevant tests/checks available in this repo (do not invent commands).
- If no tests exist, add minimal tests for new logic or provide a reproducible manual verification checklist.

# Documentation (always-on)
- Update docs in the same change as code (README / docs/ / API docs / architecture notes).
- When behavior changes, document what changed, how to use it, how to verify it, and any breaking changes.

# Output expectation
When delivering a change, include:
- What changed
- How to verify
- What docs were updated
- Remaining risks / follow-ups