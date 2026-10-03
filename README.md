# pi-cmux-race

Native Parallel Competitive Race-and-Notify orchestration tool for the **Pi Coding Agent** in **cmux**, inspired by Dan Disler's ([IndyDevDan](https://github.com/disler)) *SEE CMUX SOLVE Multi-Agent Orchestration*.

## The Problem

When facing hard bugs, stubborn test failures, or exploratory refactors, a single sequential agent can easily enter circular debugging loops.

## The Solution

`pi-cmux-race` brings the **Race-and-Notify pattern** directly into Pi:
1. **Tool `cmux_race`**: Spawns 2–4 competing runner commands in atomic cmux splits (`new-split --command '<cmd>'`).
2. **Visual Telemetry**: Sets live status pills and progress tracking in the cmux sidebar (`set-status race` & `set-progress`).
3. **First-to-Finish Harvesting**: The first runner to finish with exit code 0 (and pass optional `verifyCommand` checks) is declared the winner.
4. **Automated Teardown**: Immediately tears down the losing/redundant splits (`close-surface`) to free CPU/RAM and keep the workspace tidy.
5. **TypeSafe Jev Validation**: Rapid quality evaluation of the winning solution.

## Isolation and verification

When the working directory is inside a git repo, each runner gets its own detached worktree at `HEAD`, so runners can't overwrite each other and `verifyCommand` checks the candidate it is judging. **Uncommitted changes are not carried into the worktrees.** The winner's worktree is kept and its path reported, so you can inspect or merge it. Losers' worktrees are removed. Outside a git repo, runners share the directory and the result says so.

Each finished runner is verified at most once. Verification runs asynchronously and is capped by the race deadline, so a winner verified after the deadline is never accepted. Each runner command is written to its own script file, so its syntax can't break the wrapper.

## Verification

```bash
bun run test.ts       # unit
bun run race.e2e.ts   # real race loop + real git worktrees, fake cmux via PI_CMUX_BIN (no panes opened)
```
