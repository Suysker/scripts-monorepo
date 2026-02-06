# Consolidate Golden-Left-Right, StreamBoost, and yfsp into one repository

This ExecPlan is a living document. The sections `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` must be kept up to date as work proceeds.

This repository includes `.agent/PLANS.md` and this document is maintained in accordance with `.agent/PLANS.md`.

## Purpose / Big Picture

After this change, there will be one Git repository that contains all three JavaScript projects in separate folders, so development and release management happen in one place instead of three repositories. The migration will preserve commit history for each original project, and users can verify success by browsing folder structure and Git log paths inside this new repository.

## Progress

- [x] (2026-02-06 00:00Z) Created the target repository at `c:/Github/js-scripts-monorepo`, initialized Git, and copied planning rules into `.agent/PLANS.md`.
- [ ] Import `c:/Github/Golden-Left-Right` into `c:/Github/js-scripts-monorepo/Golden-Left-Right` with preserved history.
- [ ] Import `c:/Github/StreamBoost` into `c:/Github/js-scripts-monorepo/StreamBoost` with preserved history.
- [ ] Import `c:/Github/yfsp` into `c:/Github/js-scripts-monorepo/yfsp` with preserved history.
- [ ] Add top-level documentation in `c:/Github/js-scripts-monorepo/README.md` describing layout, migration result, and verification.
- [ ] Run migration validation commands and capture evidence in this file.

## Surprises & Discoveries

- Observation: None yet.
  Evidence: Migration not started at plan creation time.

## Decision Log

- Decision: Create a new aggregation repository instead of rewriting any existing repository in place.
  Rationale: This is the safest default because it is reversible and does not risk damaging the three original repositories.
  Date/Author: 2026-02-06 / Codex

- Decision: Use `git subtree add` without `--squash` to import each project under its own folder.
  Rationale: This keeps the full commit history while producing a clear monorepo folder structure.
  Date/Author: 2026-02-06 / Codex

## Outcomes & Retrospective

Pending implementation.

## Context and Orientation

The source repositories are `c:/Github/Golden-Left-Right`, `c:/Github/StreamBoost`, and `c:/Github/yfsp`. Each is an independent Git repository with JavaScript script files and project-level documentation. The target repository is `c:/Github/js-scripts-monorepo`.

Key files to create or edit are `c:/Github/js-scripts-monorepo/.agent/execplans/consolidate-three-js-repos.md` for this living plan and `c:/Github/js-scripts-monorepo/README.md` for user-facing documentation. Imported project files will live under `c:/Github/js-scripts-monorepo/Golden-Left-Right`, `c:/Github/js-scripts-monorepo/StreamBoost`, and `c:/Github/js-scripts-monorepo/yfsp`.

A "subtree import" means Git copies another repository history under a directory prefix in the current repository, so later `git log -- <folder>` still shows the old commits.

## Milestones

### Milestone 1: Create the monorepo container and planning artifacts

The user-visible outcome is a new repository at `c:/Github/js-scripts-monorepo` that is ready for controlled migration work. The exact edited paths are `c:/Github/js-scripts-monorepo/.agent/PLANS.md` and `c:/Github/js-scripts-monorepo/.agent/execplans/consolidate-three-js-repos.md`. The main tool is Git CLI plus PowerShell file operations. Validation is `git status --short --branch` from `c:/Github/js-scripts-monorepo`, expecting a `main` branch and no imported project folders yet. Documentation updated in this milestone is this ExecPlan.

### Milestone 2: Import each project with preserved history

The user-visible outcome is that each original project appears under its own folder in one repository while history is preserved. Paths affected are `c:/Github/js-scripts-monorepo/Golden-Left-Right`, `c:/Github/js-scripts-monorepo/StreamBoost`, and `c:/Github/js-scripts-monorepo/yfsp`, created via `git subtree add`. The main tool is `git subtree` and repository remotes that point to local source repositories. Validation uses `git log --oneline -- <folder>` expecting non-empty commit history for each folder, plus `Get-ChildItem` to confirm files exist. Documentation updated in this milestone is the progress/evidence sections of this ExecPlan.

### Milestone 3: Add monorepo documentation and final verification

The user-visible outcome is a clear top-level `README.md` that explains what changed, current directory layout, and how to verify and continue development. Edited path is `c:/Github/js-scripts-monorepo/README.md`. Validation commands are `git status --short --branch`, `git log --oneline -- Golden-Left-Right`, `git log --oneline -- StreamBoost`, and `git log --oneline -- yfsp`, expecting clean output except new docs before commit and non-empty logs for all imported folders. Documentation updated in this milestone is `README.md` and the closing sections of this ExecPlan.

## Plan of Work

First, keep working in `c:/Github/js-scripts-monorepo` and register each source repository as a local remote with distinct names. Next, run `git fetch` for each remote and then run `git subtree add --prefix <folder> <remote> <branch>` for all three repositories, reusing the existing folder names to avoid introducing new naming concepts. After imports, create `README.md` at the monorepo root that explains why the merge was done, where each project now lives, and the exact commands to inspect history per folder.

As each stage completes, update this file at `c:/Github/js-scripts-monorepo/.agent/execplans/consolidate-three-js-repos.md` to keep Progress, Decision Log, and validation evidence current. No source files inside imported projects are modified during migration.

## Concrete Steps

Run these commands from `c:/Github/js-scripts-monorepo`.

1. Add local remotes and fetch:
   `git remote add golden ../Golden-Left-Right`
   `git remote add streamboost ../StreamBoost`
   `git remote add yfsp ../yfsp`
   `git fetch --all --tags`

   Expected result: remote refs such as `golden/main`, `streamboost/main`, and `yfsp/main` are available.

2. Import repositories under folder prefixes with history:
   `git subtree add --prefix Golden-Left-Right golden main`
   `git subtree add --prefix StreamBoost streamboost main`
   `git subtree add --prefix yfsp yfsp main`

   Expected result: each command creates files under the target prefix and records imported commits.

3. Create root documentation:
   Edit `c:/Github/js-scripts-monorepo/README.md` to describe repository consolidation, structure, and verification commands.

4. Validate:
   `Get-ChildItem -Name`
   `git log --oneline -n 5 -- Golden-Left-Right`
   `git log --oneline -n 5 -- StreamBoost`
   `git log --oneline -n 5 -- yfsp`
   `git status --short --branch`

   Expected result: all three directories exist, all logs are non-empty, and status only reflects planned documentation edits if not yet committed.

## Validation and Acceptance

Acceptance means a user can clone one repository and see all three projects inside it, then inspect history for each folder and confirm commits are present. Validation is complete when directory checks pass and per-folder `git log` commands return entries from original repositories.

If runtime tests are available in imported projects, run them from their new folder paths and record pass/fail output. If not available, the manual verification checklist above is the minimum acceptance.

## Idempotence and Recovery

The migration is safe to retry by deleting `c:/Github/js-scripts-monorepo` and recreating it because no source repository is modified. If a subtree import fails midway, rerun from a clean state after removing the target repository directory. Since source repos remain unchanged, rollback is immediate by discarding the new monorepo.

## Artifacts and Notes

Evidence snippets will be appended after each milestone with short command outputs that prove imports and history preservation.

## Interfaces and Dependencies

This work depends on standard Git commands and `git subtree`. No new runtime dependencies are introduced. Repository interfaces remain filesystem paths and Git history navigation:

`c:/Github/js-scripts-monorepo/Golden-Left-Right`
`c:/Github/js-scripts-monorepo/StreamBoost`
`c:/Github/js-scripts-monorepo/yfsp`
