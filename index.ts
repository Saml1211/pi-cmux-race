import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { execFileSync, execSync } from "node:child_process";
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
    return execFileSync("cmux", args, {
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
}

export interface RaceExecutionResult {
  winner?: {
    name: string;
    command: string;
    durationMs: number;
    log: string;
    jevEvaluation?: string;
  };
  totalRunners: number;
  durationMs: number;
  error?: string;
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

  try {
    if (signal?.aborted) {
      throw new Error("Race aborted prior to split creation");
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

      // Wrapper script with safe directory check
      const escapedCwd = cwd.replace(/(["$`\\])/g, "\\$1");
      const scriptContent = `#!/bin/bash
cd "${escapedCwd}" || exit 1
(${r.command}) > "${logFile}" 2>&1
echo $? > "${exitFile}"
touch "${doneFile}"
`;
      writeFileSync(scriptFile, scriptContent, { mode: 0o755 });

      // Atomic split creation
      const out = safeCmux([
        "new-split",
        i === 0 ? "right" : "down",
        "--command",
        `bash ${scriptFile}`,
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

    // 3. Polling race loop (Wait-for-first-winner with timestamp ordering)
    let winner: RaceRunnerConfig | null = null;

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
          if (exitCode === "0") {
            completedRunners.push(r);
          }
        }
      }

      // Sort by earliest completed timestamp to eliminate array-order bias
      completedRunners.sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));

      for (const candidate of completedRunners) {
        let verifyPass = true;
        if (verifyCmd) {
          try {
            execSync(verifyCmd, { cwd, stdio: "ignore", timeout: 15000 });
          } catch {
            verifyPass = false;
          }
        }

        if (verifyPass) {
          winner = candidate;
          break;
        }
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
      },
      totalRunners: runners.length,
      durationMs,
    };
  } finally {
    // Unconditional runner teardown: close all created surfaces so no orphaned panes remain
    for (const surface of createdSurfaces) {
      safeCmux(["close-surface", "--surface", surface]);
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

      if (result.error) {
        return {
          content: [{ type: "text", text: `[cmux_race failure]: ${result.error}` }],
        };
      }

      const win = result.winner!;
      const jevReport = win.jevEvaluation ? ` (${win.jevEvaluation})` : "";
      const text = `🏆 [cmux_race WINNER]: '${win.name}' completed in ${(win.durationMs / 1000).toFixed(1)}s${jevReport}!\nCommand: \`${win.command}\`\n\nExecution Log:\n\`\`\`\n${win.log}\n\`\`\`\n\nRedundant runner panes were cleanly terminated.`;

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
