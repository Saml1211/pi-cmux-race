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

Inside a git repo, each runner gets its own detached worktree at `HEAD`, so runners can't overwrite each other and `verifyCommand` checks the candidate it is judging. Isolation **fails closed**: if any worktree can't be created, or the repo has no commits, the race refuses to start rather than run in your checkout. Runners start from the same subdirectory as your cwd.

Things worktrees don't carry over:
- uncommitted changes
- untracked directories
- initialised submodule content (bootstrap it in the runner command if needed)

The winner's worktree root is kept and reported, so you can inspect or merge it. Losers' worktrees are removed. Outside a git repo, runners share the directory and the result says so.

Each finished runner is verified at most once. Verification runs asynchronously in its own process group, capped by the race deadline. On expiry or abort the whole group gets SIGTERM, then SIGKILL after 2 s. A timed-out verify never counts as a pass.

Each runner command runs in its own process group (the wrapper uses `set -m`), recorded at launch. Teardown kills every runner's group first, including runners that finished but left background children. Only then does it close panes and remove worktrees. A group that survives SIGKILL keeps its worktree, and it is reported in `cleanupWarnings` on every result, including errors.

If a verify descendant escapes the group with `setsid` and holds the output pipes, the call still settles 5 s after the first kill signal and reports `escaped`. Output is capped by bytes (10 MB).

## Verification

```bash
bun run test.ts       # unit
bun run race.e2e.ts   # real race loop + real git worktrees, fake cmux via PI_CMUX_BIN (no panes opened)
```
