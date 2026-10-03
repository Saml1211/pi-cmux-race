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

## Verification

```bash
node --input-type=module test.ts
```
