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

Each finished runner is verified at most once. Verification runs asynchronously in its own process group, capped by the race deadline. On expiry or abort the whole group gets SIGTERM, then SIGKILL after 2 s. A timed-out verify never counts as a pass. A group that outlives its leader is signalled only while a member seen in it is still in it (re-checked before every signal); otherwise nothing is sent and a cleanup warning is added, with the worktree kept. Teardown's `killGroup` proves ownership the same way before TERM and again before KILL.

Each runner command runs in its own process group (the wrapper uses `set -m`). The group's leader records its id *before* running anything, and it refuses to start once teardown has begun. Teardown drops that cancel marker first, so a runner can never execute unowned, even if teardown lands mid-launch.

Teardown kills every runner's group first, including runners that finished but left background children. Only then does it close panes and remove worktrees. It only signals a group it can prove it owns. After the command finishes, the group's leader records the exit status and stays alive until teardown, capped at the race timeout plus 10 minutes. A live leader whose argv carries the race directory is that proof. If the leader is gone or is a zombie, the ID may have been recycled, so the group is left alone and reported. A group that survives SIGKILL, or that can't be proven ours, keeps its worktree. Both cases are reported in `cleanupWarnings` on every result, including errors and cancellation. Cancellation returns a result; it does not throw.

Runners are non-interactive: stdin is `/dev/null`, so a command that reads input gets EOF instead of stalling.

If the verify command exits but leaves background processes in its group, they are killed and a warning says so. If a verify descendant escapes the group with `setsid` and holds the output pipes, the call still settles 5 s after the first kill signal. A warning names the runner, and that worktree is kept rather than deleted under the escaped process. Before removing any worktree, teardown also checks with `lsof` for processes whose working directory is inside it. This catches escapees that closed their pipes. If any are found, or `lsof` fails, the worktree is kept and the warning lists the PIDs. A process that changed directory elsewhere but still holds files open is not detected. Output is capped by bytes (10 MB).

## Verification

```bash
bun run test.ts       # unit
bun run race.e2e.ts   # real race loop + real git worktrees, fake cmux via PI_CMUX_BIN (no panes opened)
```

**Windows:** `runBounded` runs verify commands in the bash Pi itself would use (Pi's merged settings: global `shellPath`, overridden by the project's `.pi/settings.json` only when `trust.json` trusts the project, else Git Bash; WSL's `bash.exe` is refused with a clear error), kills the process tree with `taskkill /F /T`, and does not detect stray background processes. A trust decision Pi holds only in memory (this session, `--trust-project`) is not visible to the extension, so that project's `shellPath` is ignored. A signal that is already aborted never starts the command, including one aborted while the shell is being resolved.
