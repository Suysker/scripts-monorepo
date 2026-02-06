# JavaScript Scripts Monorepo

This repository consolidates these three previously separate repositories into one place:

- `Golden-Left-Right`
- `StreamBoost`
- `yfsp`

The goals are to keep related JavaScript scripts together and simplify maintenance.

## Directory Layout

- `Golden-Left-Right/`: original Golden-Left-Right project files and history.
- `StreamBoost/`: original StreamBoost project files and history.
- `yfsp/`: original yfsp project files and history.
- `.agent/`: planning and migration execution documents.

## Migration Method

The migration used `git subtree add` for each project, without squashing history, so commit history is preserved per directory.

## How To Verify

Run the following from this repository root:

```powershell
git log --oneline -n 5 -- Golden-Left-Right
git log --oneline -n 5 -- StreamBoost
git log --oneline -n 5 -- yfsp
```

Each command should return non-empty commit history.

## Notes

- The original repositories under `c:/Github/Golden-Left-Right`, `c:/Github/StreamBoost`, and `c:/Github/yfsp` were not modified.
- New work can now be managed in this single repository.
