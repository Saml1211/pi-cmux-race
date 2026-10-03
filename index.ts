import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ponytail: native cmux CLI wrapper; argv-based execution immune to shell injection
const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

function isCmuxActive(): boolean {
  return Boolean(
    process.env.CMUX_SOCKET_PATH ||
    process.env.CMUX_WORKSPACE_ID ||
    process.env.CMUX_SURFACE_ID
  );
}

export function safeCmux(args: string[]): string {
  try {
    // PI_CMUX_BIN lets tests substitute a fake cmux instead of opening real panes
    return execFileSync(process.env.PI_CMUX_BIN || "cmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
  } catch {
    return "";
  }
}

function resolveJevApiKey(): string | undefined {
  if (process.env.TYPESAFE_API_KEY?.trim()) {
    return process.env.TYPESAFE_API_KEY.trim();
  }
  try {
    const configPath = join(homedir(), ".pi/agent/pi-jev.json");
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg.apiKey?.trim()) return cfg.apiKey.trim();
      if (cfg.apiKeyFile) {
        const keyFilePath = cfg.apiKeyFile.replace(/^~(?=$|\/)/, homedir());
        if (existsSync(keyFilePath)) {
          return readFileSync(keyFilePath, "utf8").trim();
        }
      }
    }
  } catch {}
  return undefined;
}

export interface RaceRunnerConfig {
  name: string;
  command: string;
  surfaceId?: string;
  surfaceRef?: string;
  completedAt?: number;
  workdir?: string; // where the runner runs: worktree (+ nested prefix), or the shared cwd outside git
  worktreeRoot?: string;
  verifyFailed?: boolean; // verified once and failed; never re-verify
}


export interface BoundedResult { code: number | null; out: string; timedOut: boolean; aborted: boolean; escaped: boolean }

// Run a shell command in its own process group; on timeout/abort kill the WHOLE group (TERM, then
// KILL after 2 s), so descendants can't outlive it and a timed-out command can never count as a pass.
// A descendant that left the group (setsid) and holds our pipes would block 'close' forever, so the
// call also settles 5 s after the first kill signal no matter what, closing its pipes and reporting escaped: true.
// ponytail: duplicated in pi-adw (separate repos); setsid escapees are reported, not hunted down.
export function runBounded(cmd: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxBytes?: number }): Promise<BoundedResult> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", cmd], { cwd: o.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const max = o.maxBytes ?? 10 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let bytes = 0, truncated = false;
    const add = (b: Buffer) => {
      const room = max - bytes;
      if (room <= 0) { truncated = true; return; }
      const part = b.length > room ? b.subarray(0, room) : b;
      if (part.length < b.length) truncated = true;
      chunks.push(part);
      bytes += part.length;
    };
    child.stdout!.on("data", add);
    child.stderr!.on("data", add);
    let timedOut = false, aborted = false, escaped = false, done = false;
    let killTimer: NodeJS.Timeout | undefined, settleTimer: NodeJS.Timeout | undefined;
    const group = (sig: NodeJS.Signals) => { try { process.kill(-child.pid!, sig); } catch {} };
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (killTimer) { clearTimeout(killTimer); group("SIGKILL"); } // sweep stragglers still in the group
      clearTimeout(settleTimer);
      o.signal?.removeEventListener("abort", onAbort);
      const out = Buffer.concat(chunks).toString("utf8") + (truncated ? "\n… (output truncated)" : "");
      resolve({ code, out, timedOut, aborted, escaped });
    };
    const stop = () => {
      group("SIGTERM");
      killTimer ??= setTimeout(() => group("SIGKILL"), 2000);
      settleTimer ??= setTimeout(() => {
        escaped = true;
        child.stdout!.destroy();
        child.stderr!.destroy();
        finish(child.exitCode);
      }, 5000);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, Math.max(1, o.timeoutMs));
    const onAbort = () => { aborted = true; stop(); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => { chunks.push(Buffer.from(String(e))); });
    child.on("close", (code) => finish(code));
  });
}

const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

// Each runner's command runs as its own process group (wrapper uses `set -m`), recorded at launch.
// Killing the group reaches backgrounded descendants even after the wrapper itself has exited.
// ponytail: no identity check before signalling, so a recycled PGID in the seconds-long window
// between launch and teardown could be hit; upgrade path is a start-time check via ps.
async function killGroup(pgid: number): Promise<boolean> {
  if (!groupAlive(pgid)) return true;
  try { process.kill(-pgid, "SIGTERM"); } catch {}
  for (let i = 0; i < 10 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
  if (groupAlive(pgid)) try { process.kill(-pgid, "SIGKILL"); } catch {}
  for (let i = 0; i < 5 && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
  return !groupAlive(pgid);
}

function git(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
  } catch {
    return null;
  }
}

export interface RaceExecutionResult {
  winner?: {
    name: string;
    command: string;
    durationMs: number;
    log: string;
    jevEvaluation?: string;
    worktree?: string; // worktree ROOT, kept for inspection/merge when runners were isolated
  };
  totalRunners: number;
  durationMs: number;
  isolated: boolean;
  cleanupWarnings: string[];
  error?: string;
}

function readFileSafe(p: string): string {
  try { return readFileSync(p, "utf8").trim(); } catch { return ""; }
}

export async function runCmuxRace(
  goal: string,
  runnerCmds: string[],
  verifyCmd?: string,
  timeoutSeconds = 120,
  cwd = process.cwd(),
  signal?: AbortSignal,
): Promise<RaceExecutionResult> {
  // Use unique temporary directory to prevent race collision
  const raceDir = mkdtempSync(join(os.tmpdir(), "pi-cmux-race-"));

  const runners: RaceRunnerConfig[] = runnerCmds.map((cmd, i) => ({
    name: `runner-${i + 1}`,
    command: cmd,
  }));

  const startTime = Date.now();
  const maxMs = Math.max(5, timeoutSeconds) * 1000;
  const deadline = startTime + maxMs;

  const createdSurfaces: string[] = [];
  // Each runner gets its own detached worktree at HEAD, so runners cannot clobber each other and
  // verifyCmd tests the candidate it is judging. Uncommitted changes in cwd are NOT carried over.
  const repoRoot = git(["rev-parse", "--show-toplevel"], cwd);
  const repoPrefix = git(["rev-parse", "--show-prefix"], cwd) ?? "";
  const worktreeBase = repoRoot ? mkdtempSync(join(os.tmpdir(), "pi-cmux-race-wt-")) : null;
  const createdWorktrees: string[] = [];
  const cleanupWarnings: string[] = [];
  let winner: RaceRunnerConfig | null = null;

  try {
    if (signal?.aborted) {
      throw new Error("Race aborted prior to split creation");
    }

    // 0. Inside a git repo, every runner MUST get its own worktree; never fall back to the caller's
    // checkout (a runner would then edit it while the result claimed isolation).
    if (repoRoot && worktreeBase) {
      if (git(["rev-parse", "--verify", "-q", "HEAD"], repoRoot) === null) {
        return { totalRunners: runners.length, durationMs: 0, isolated: false, cleanupWarnings, error: "Repository has no commits, so runners cannot be isolated in worktrees. Commit first, or run outside the repo." };
      }
      for (const r of runners) {
        const wt = join(worktreeBase, r.name);
        if (git(["worktree", "add", "--detach", wt, "HEAD"], repoRoot) === null) {
          return { totalRunners: runners.length, durationMs: 0, isolated: false, cleanupWarnings, error: `Could not create an isolated worktree for ${r.name}; refusing to run in your checkout.` };
        }
        createdWorktrees.push(wt);
        r.worktreeRoot = wt;
        // same position inside the repo as the caller's cwd (--show-prefix avoids /var vs /private/var mismatches)
        r.workdir = join(wt, repoPrefix);
      }
    }

    // 1. Set cmux visual status (argv-based safe commands)
    safeCmux(["set-status", "race", `🏃 ${runners.length} racing`, "--icon", "figure.run", "--color", "#ff9500"]);
    safeCmux(["set-progress", "0.1", "--label", `Race: ${goal.slice(0, 30)}...`]);

    // 2. Spawn runner splits atomically
    for (let i = 0; i < runners.length; i++) {
      if (signal?.aborted) {
        throw new Error("Race aborted during runner launch");
      }

      const r = runners[i];
      const logFile = join(raceDir, `${r.name}.log`);
      const exitFile = join(raceDir, `${r.name}.exit`);
      const doneFile = join(raceDir, `${r.name}.done`);
      const scriptFile = join(raceDir, `${r.name}.sh`);
      const cmdFile = join(raceDir, `${r.name}.cmd.sh`);

      r.workdir ??= cwd; // only outside git (worktrees were created above, fail-closed)
      const pgidFile = join(raceDir, `${r.name}.pgid`);

      // The runner command is a shell command by design; it lives in its own file so its
      // syntax (unbalanced parens, heredocs) cannot break the wrapper.
      writeFileSync(cmdFile, r.command + "\n", { mode: 0o600 });
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      // set -m: the background job gets its own process group (pgid = its pid), which teardown kills.
      const scriptContent = `#!/bin/bash
set -m
cd ${q(r.workdir)} || { echo 1 > ${q(exitFile)}; touch ${q(doneFile)}; exit 1; }
bash ${q(cmdFile)} > ${q(logFile)} 2>&1 &
echo $! > ${q(pgidFile)}
wait $!
echo $? > ${q(exitFile)}
touch ${q(doneFile)}
`;
      writeFileSync(scriptFile, scriptContent, { mode: 0o700 });

      // Atomic split creation
      const out = safeCmux([
        "new-split",
        i === 0 ? "right" : "down",
        "--command",
        `bash '${scriptFile.replace(/'/g, `'\\''`)}'`,
        "--focus",
        "false",
        "--id-format",
        "both",
      ]);

      const match = out.match(/([0-9a-fA-F-]{36})/);
      if (match) {
        r.surfaceId = match[1];
        createdSurfaces.push(match[1]);
      }
      const refMatch = out.match(/(surface:\d+)/);
      if (refMatch) {
        r.surfaceRef = refMatch[1];
        if (!r.surfaceId) createdSurfaces.push(refMatch[1]);
      }
    }

    // 3. Polling race loop (first verified finisher wins; each runner is verified at most once)

    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("Race aborted by caller");
      }

      const completedRunners: RaceRunnerConfig[] = [];

      for (const r of runners) {
        const doneFile = join(raceDir, `${r.name}.done`);
        const exitFile = join(raceDir, `${r.name}.exit`);

        if (existsSync(doneFile) && existsSync(exitFile)) {
          if (!r.completedAt) {
            try {
              r.completedAt = statSync(doneFile).mtimeMs;
            } catch {
              r.completedAt = Date.now();
            }
          }
          const exitCode = readFileSync(exitFile, "utf8").trim();
          if (exitCode === "0" && !r.verifyFailed) {
            completedRunners.push(r);
          }
        }
      }

      // Sort by earliest completed timestamp to eliminate array-order bias
      completedRunners.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));

      for (const candidate of completedRunners) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break; // never accept a winner verified after the deadline
        let verifyPass = true;
        if (verifyCmd) {
          // async (Pi stays responsive), bounded by the race deadline, whole process group killed on expiry
          const v = await runBounded(verifyCmd, { cwd: candidate.workdir!, timeoutMs: Math.min(60000, remaining), signal });
          verifyPass = v.code === 0 && !v.timedOut && !v.aborted;
        }
        if (verifyPass && Date.now() <= deadline) {
          winner = candidate;
          break;
        }
        candidate.verifyFailed = true;
      }

      if (winner) break;

      const elapsed = Date.now() - startTime;
      const pct = Math.min(0.9, elapsed / maxMs).toFixed(2);
      safeCmux(["set-progress", pct, "--label", `Racing: ${Math.round(elapsed / 1000)}s elapsed`]);

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    const durationMs = Date.now() - startTime;

    if (!winner) {
      return {
        totalRunners: runners.length,
        durationMs,
        isolated: createdWorktrees.length > 0,
        cleanupWarnings,
        error: `Race timed out after ${timeoutSeconds}s without a verified winner.`,
      };
    }

    // Read winning log
    const winningLogFile = join(raceDir, `${winner.name}.log`);
    let logOutput = "";
    if (existsSync(winningLogFile)) {
      logOutput = readFileSync(winningLogFile, "utf8").trim();
    }
    if (!logOutput && (winner.surfaceId || winner.surfaceRef)) {
      logOutput = safeCmux(["read-screen", "--surface", winner.surfaceId || winner.surfaceRef!, "--lines", "60"]);
    }

    // 5. TypeSafe Jev quality evaluation on winning solution
    let jevText = "";
    const jevApiKey = resolveJevApiKey();
    if (jevApiKey && logOutput) {
      try {
        const body = {
          state: `Goal: ${goal}\nRunner: ${winner.name}\nExecution output:\n${logOutput.slice(-2000)}`,
          model: JEV_MODEL,
          questions: {
            is_valid_solution: {
              type: "noul",
              instructions: "Does this execution output demonstrate a complete, working solution to the goal?",
            },
          },
        };
        const res = await fetch(JEV_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${jevApiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const json = (await res.json()) as any;
          const validScore = json?.answers?.is_valid_solution?.noul;
          if (typeof validScore === "number" && Number.isFinite(validScore)) {
            jevText = `Jev confidence: ${Math.round(validScore * 100)}%`;
          }
        }
      } catch {}
    }

    return {
      winner: {
        name: winner.name,
        command: winner.command,
        durationMs,
        log: logOutput.slice(0, 3000),
        jevEvaluation: jevText || undefined,
        worktree: winner.worktreeRoot,
      },
      totalRunners: runners.length,
      durationMs,
      isolated: createdWorktrees.length > 0,
      cleanupWarnings, // same array: entries added during teardown (finally) reach the caller
    };
  } finally {
    // 1. Kill every runner's process group FIRST (finished runners too: their background children
    //    may still be running). Pane closure is not process ownership and is not relied on.
    const survivors = new Set<string>();
    for (const r of runners) {
      const pgid = Number(readFileSafe(join(raceDir, `${r.name}.pgid`)));
      if (pgid > 1 && !(await killGroup(pgid))) {
        survivors.add(r.name);
        cleanupWarnings.push(`${r.name} (process group ${pgid}) survived SIGKILL; its worktree was kept`);
      }
    }
    // 2. Then close the panes
    for (const surface of createdSurfaces) {
      safeCmux(["close-surface", "--surface", surface]);
    }

    // Remove every worktree except the winner's (kept so its changes can be inspected/merged)
    const keep = winner?.worktreeRoot ?? null;
    for (const wt of createdWorktrees) {
      const owner = runners.find((r) => r.worktreeRoot === wt);
      if (wt !== keep && !(owner && survivors.has(owner.name))) git(["worktree", "remove", "--force", wt], repoRoot!);
    }
    if (repoRoot) git(["worktree", "prune"], repoRoot);
    if (worktreeBase && !keep && survivors.size === 0) {
      try {
        rmSync(worktreeBase, { recursive: true, force: true });
      } catch {}
    }

    // Always clear cmux status and clean temporary race files
    safeCmux(["clear-status", "race"]);
    safeCmux(["clear-progress"]);
    try {
      rmSync(raceDir, { recursive: true, force: true });
    } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  // 1. Tool: cmux_race (conforming to Pi's 5-argument execute signature)
  pi.registerTool({
    name: "cmux_race",
    label: "cmux Parallel Race-and-Notify",
    description:
      "Spawns parallel competing runner commands in cmux splits to solve a goal. As soon as the first runner passes tests, automatically tears down losing panes, reports the winning solution, and clears sidebar status.",
    promptSnippet: "Use cmux_race to race 2-3 parallel strategies/models in cmux panes against a difficult test or bug.",
    parameters: Type.Object({
      goal: Type.String({ description: "High-level goal or problem statement" }),
      runnerCommands: Type.Array(Type.String(), {
        description: "List of 2-3 distinct runner shell commands racing to complete the goal",
        minItems: 2,
        maxItems: 4,
      }),
      verifyCommand: Type.Optional(
        Type.String({ description: "Optional verification command (e.g. 'npm test') to validate winner" }),
      ),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Max seconds before aborting race (default: 120)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!isCmuxActive()) {
        return {
          content: [
            {
              type: "text",
              text: "[cmux_race error]: Active cmux terminal environment not detected. cmux_race requires running inside a live cmux session with socket access.",
            },
          ],
        };
      }

      const effectiveCtx: ExtensionContext | undefined = ctx || (signal && (signal as any).cwd ? (signal as any) : undefined);
      const effectiveSignal: AbortSignal | undefined = signal instanceof AbortSignal ? signal : effectiveCtx?.signal;

      effectiveCtx?.ui?.notify?.(`[cmux-race] Starting race across ${params.runnerCommands.length} runners...`, "info");
      const result = await runCmuxRace(
        params.goal,
        params.runnerCommands,
        params.verifyCommand,
        params.timeoutSeconds || 120,
        effectiveCtx?.cwd || process.cwd(),
        effectiveSignal,
      );

      const warn = result.cleanupWarnings.length ? `\n⚠️ Cleanup: ${result.cleanupWarnings.join("; ")}` : "";
      if (result.error) {
        return {
          content: [{ type: "text", text: `[cmux_race failure]: ${result.error}${warn}` }],
        };
      }

      const win = result.winner!;
      const jevReport = win.jevEvaluation ? ` (${win.jevEvaluation})` : "";
      const text = `🏆 [cmux_race WINNER]: '${win.name}' completed in ${(win.durationMs / 1000).toFixed(1)}s${jevReport}!\nCommand: \`${win.command}\`\n\nExecution Log:\n\`\`\`\n${win.log}\n\`\`\`\n\nRedundant runner panes were closed.${warn}${win.worktree ? `\nWinner's changes are in worktree: ${win.worktree} (inspect, then merge or \`git worktree remove\` it).` : result.isolated ? "" : "\nRunners shared the working directory (not a git repo), so they were not isolated."}`;

      return {
        content: [{ type: "text", text }],
      };
    },
  });

  // 2. Slash command: /cmux-race
  pi.registerCommand("cmux-race", {
    description: "Inspect cmux race status or initiate a test race",
    handler: async (_args, ctx) => {
      const active = isCmuxActive();
      ctx.ui?.notify?.(
        `[cmux-race] cmux environment: ${active ? "active (socket connected)" : "disconnected"}`,
        active ? "info" : "warning",
      );
    },
  });
}
