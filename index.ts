import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync, realpathSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
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


export interface BoundedResult { code: number | null; out: string; timedOut: boolean; aborted: boolean; escaped: boolean; strays: boolean }
const win = process.platform === "win32";
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };

// Run a shell command in its own process group; on timeout/abort kill the WHOLE group (TERM, then
// KILL after 2 s), so descendants can't outlive it and a timed-out command can never count as a pass.
// A descendant that left the group (setsid) and holds our pipes would block 'close' forever, so the
// call also settles 5 s after the first kill signal no matter what, closing its pipes and reporting escaped: true.
// A command that exits normally but leaves background processes in its group (pipes closed, so 'close'
// still fires) has them killed too, reported as strays: true.
// On native Windows there are no process groups: bash is Pi's configured shell (never WSL's bash.exe), the
// tree is killed with `taskkill /F /T` for both stages, and strays are not detected.
// ponytail: taskkill /T cannot reach processes that left the tree (Pi issue #9129); the 5 s settle still bounds the call.
// ponytail: duplicated in pi-adw (separate repos); setsid escapees are reported, not hunted down.
async function winShell(): Promise<string> {
  const pi: any = await import("@earendil-works/pi-coding-agent");
  let shellPath: string | undefined;
  try { shellPath = JSON.parse(readFileSync(join(pi.getAgentDir(), "settings.json"), "utf8")).shellPath; } catch {}
  const sh = pi.getShellConfig(shellPath);
  if (sh.commandTransport === "stdin") throw new Error("only WSL bash found; install Git for Windows or set shellPath in Pi settings.json");
  return sh.shell;
}
export async function runBounded(cmd: string, o: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxBytes?: number }): Promise<BoundedResult> {
  let shell = "bash";
  if (win) try { shell = await winShell(); } catch (e: any) { return { code: null, out: `runBounded: ${e?.message ?? e}`, timedOut: false, aborted: false, escaped: false, strays: false }; }
  return new Promise((resolve) => {
    const child = spawn(shell, ["-c", cmd], { cwd: o.cwd, detached: !win, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
    // A PGID is only reused once its group is empty, and the new group's leader has pid == pgid. So once
    // our leader has been reaped, a live process with that pid means the id is someone else's: hands off.
    const group = (sig: NodeJS.Signals) => {
      const reaped = child.exitCode !== null || child.signalCode !== null;
      if (win) { if (!reaped) execFile(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true }, () => {}); return; }
      if (reaped && pidAlive(child.pid!)) return;
      try { process.kill(-child.pid!, sig); } catch {}
    };
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(settleTimer);
      o.signal?.removeEventListener("abort", onAbort);
      // Members left in the group: the id cannot be reused while they live, so it is still ours.
      const strays = !win && !killTimer && groupAlive(child.pid!);
      if (killTimer) { clearTimeout(killTimer); group("SIGKILL"); } // sweep stragglers still in the group
      const out = Buffer.concat(chunks).toString("utf8") + (truncated ? "\n… (output truncated)" : "");
      const result = { code, out, timedOut, aborted, escaped, strays };
      if (!strays) return resolve(result);
      group("SIGTERM");
      setTimeout(() => { group("SIGKILL"); resolve(result); }, 500);
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

// Each runner's job leader is `bash -c <script> race-leader <race dir>/<runner>.pgid ...`: it records its
// own pid (= its process group) before running anything, never execs, and stays alive until teardown
// (it waits for its .pgid file to disappear), so a live leader whose argv carries our race dir is the
// proof the group is ours. A missing or zombie leader proves nothing (the id may have been recycled
// by an unrelated group whose own leader then exited), so that group is left alone and reported.
function ownsGroup(pgid: number, marker: string): boolean {
  if (!pidAlive(pgid)) return false;
  let ps = "";
  try { ps = execFileSync("ps", ["-ww", "-o", "stat=,command=", "-p", String(pgid)], { encoding: "utf8" }); } catch {}
  return !ps.trimStart().startsWith("Z") && ps.includes(marker);
}

export async function killGroup(pgid: number, marker: string): Promise<"gone" | "killed" | "survived" | "foreign"> {
  // a leader that just exited (cancel marker) may still be a zombie for a moment: let it be reaped
  for (let i = 0; i < 10 && groupAlive(pgid) && !ownsGroup(pgid, marker); i++) await new Promise((r) => setTimeout(r, 100));
  if (!groupAlive(pgid)) return "gone";
  if (!ownsGroup(pgid, marker)) return "foreign";
  // Proven ours once; the id cannot be reused until every member is gone, so it stays ours while alive.
  for (const [sig, polls] of [["SIGTERM", 10], ["SIGKILL", 5]] as const) {
    if (!groupAlive(pgid)) break;
    try { process.kill(-pgid, sig); } catch {}
    for (let i = 0; i < polls && groupAlive(pgid); i++) await new Promise((r) => setTimeout(r, 100));
  }
  return groupAlive(pgid) ? "survived" : "killed";
}

// Processes (any session or group) whose working directory is inside dir: catches what a group kill
// cannot reach (setsid escapees), so their worktree is not deleted under them. null = could not check.
// ponytail: only the cwd is checked; a process that chdir'd away but holds files open is missed.
export function procsUnder(dir: string): number[] | null {
  let out = "";
  try {
    out = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpn", "-u", String(process.getuid!())], { encoding: "utf8", timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e: any) {
    if (typeof e?.stdout !== "string" || !e.stdout) return e?.status === 1 ? [] : null; // 1 = nothing matched
    out = e.stdout;
  }
  let root = dir;
  try { root = realpathSync(dir); } catch {}
  const pids: number[] = [];
  let pid = 0;
  for (const line of out.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && (line.slice(1) === root || line.slice(1).startsWith(root + "/")) && pid !== process.pid) pids.push(pid);
  }
  return pids;
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
  const keptWorktrees = new Set<string>(); // processes may still run there: never delete
  const cancelFile = join(raceDir, "cancel");
  let winner: RaceRunnerConfig | null = null;
  // Cancellation is a result, not a throw, so teardown warnings still reach the caller
  const cancelled = (when: string): RaceExecutionResult => ({
    totalRunners: runners.length,
    durationMs: Date.now() - startTime,
    isolated: createdWorktrees.length > 0,
    cleanupWarnings,
    error: `Race cancelled ${when}.`,
  });

  try {
    if (signal?.aborted) {
      return cancelled("before any runner started");
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
        return cancelled("while launching runners");
      }

      const r = runners[i];
      const logFile = join(raceDir, `${r.name}.log`);
      const exitFile = join(raceDir, `${r.name}.exit`);
      const doneFile = join(raceDir, `${r.name}.done`);
      const scriptFile = join(raceDir, `${r.name}.sh`);
      const cmdFile = join(raceDir, `${r.name}.cmd.sh`);

      r.workdir ??= cwd; // only outside git (worktrees were created above, fail-closed)
      const pgidFile = join(raceDir, `${r.name}.pgid`);
      const linger = Math.ceil(timeoutSeconds) + 600; // seconds; bounds the leader if Pi dies mid-race

      // The runner command is a shell command by design; it lives in its own file so its
      // syntax (unbalanced parens, heredocs) cannot break the wrapper.
      writeFileSync(cmdFile, r.command + "\n", { mode: 0o600 });
      const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
      // set -m: the job gets its own process group (pgid = its pid). Its leader writes that id BEFORE
      // running anything and refuses to start once teardown has begun (cancel marker), so there is no
      // window where a runner executes unowned. "; exit $?" stops bash exec-ing the command over the
      // leader, keeping its argv (our race dir) as identity. Runners are non-interactive: stdin is
      // /dev/null, so a command that reads input gets EOF instead of being stopped by SIGTTIN.
      // After the command it records the exit status and lingers (until teardown deletes its .pgid file,
      // capped) so the group keeps a live, identifiable leader for teardown's ownership check.
      const scriptContent = `#!/bin/bash
set -m
cd ${q(r.workdir)} || { echo 1 > ${q(exitFile)}; touch ${q(doneFile)}; exit 1; }
bash -c 'echo $$ > "$1" || exit 125; [ -e "$2" ] && exit 125; bash "$3"; s=$?; echo $s > "$4"; touch "$5"; i=0; while [ -e "$1" ] && [ $i -lt $6 ]; do sleep 1; i=$((i+1)); done; exit $s' race-leader ${q(pgidFile)} ${q(cancelFile)} ${q(cmdFile)} ${q(exitFile)} ${q(doneFile)} ${linger} > ${q(logFile)} 2>&1 < /dev/null &
wait $!
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
        return cancelled("by the caller");
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
          if (v.strays) cleanupWarnings.push(`${candidate.name}: the verify command left background processes; they were killed`);
          if (v.escaped) {
            if (candidate.worktreeRoot) keptWorktrees.add(candidate.worktreeRoot);
            cleanupWarnings.push(`${candidate.name}: a verify process left its process group and may still be running in ${candidate.worktreeRoot ?? candidate.workdir}${candidate.worktreeRoot ? "; that worktree was kept" : ""}`);
          }
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
    // The cancel marker goes down BEFORE reading the ids: a leader writes its id and then checks the
    // marker, so either we read its id here or it sees the marker and never runs the command.
    try { writeFileSync(cancelFile, ""); } catch {}
    for (const r of runners) {
      const pgid = Number(readFileSafe(join(raceDir, `${r.name}.pgid`)));
      if (!(pgid > 1)) continue;
      const outcome = await killGroup(pgid, raceDir);
      if (outcome === "survived" || outcome === "foreign") {
        if (r.worktreeRoot) keptWorktrees.add(r.worktreeRoot);
        cleanupWarnings.push(outcome === "survived"
          ? `${r.name}: process group ${pgid} survived SIGKILL${r.worktreeRoot ? "; its worktree was kept" : ""}`
          : `${r.name}: process group ${pgid} could not be proven ours (its leader is gone or unrelated), so it was not signalled${r.worktreeRoot ? "; its worktree was kept" : ""}`);
      }
    }
    // 2. Then close the panes
    for (const surface of createdSurfaces) {
      safeCmux(["close-surface", "--surface", surface]);
    }

    // Remove every worktree except the winner's (kept so its changes can be inspected/merged)
    const keep = winner?.worktreeRoot ?? null;
    for (const wt of createdWorktrees) {
      if (wt === keep || keptWorktrees.has(wt)) continue;
      const live = procsUnder(wt); // never delete a directory a live process is working in
      if (live === null || live.length > 0) {
        keptWorktrees.add(wt);
        cleanupWarnings.push(live === null
          ? `could not check for processes still using ${wt} (lsof failed); that worktree was kept`
          : `processes ${live.join(", ")} are still running in ${wt}; that worktree was kept`);
        continue;
      }
      git(["worktree", "remove", "--force", wt], repoRoot!);
    }
    if (repoRoot) git(["worktree", "prune"], repoRoot);
    if (worktreeBase && !keep && keptWorktrees.size === 0) {
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
