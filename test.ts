import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import registerCmuxRace, { runCmuxRace } from "./index.ts";

console.log("=== Testing pi-cmux-race extension ===");

const cwd = "/tmp/pi-cmux-race-tests";
fs.mkdirSync(cwd, { recursive: true });

// 1. Tool and Command Registration Test
const registeredTools = new Map();
const registeredCommands = new Map();

const mockPi = {
  registerTool(tool: any) {
    registeredTools.set(tool.name, tool);
  },
  registerCommand(name: string, cmd: any) {
    registeredCommands.set(name, cmd);
  },
  on() {},
};

registerCmuxRace(mockPi as any);

assert(registeredTools.has("cmux_race"), "cmux_race tool must be registered");
assert(registeredCommands.has("cmux-race"), "/cmux-race command must be registered");
const raceTool = registeredTools.get("cmux_race");
assert.equal(raceTool.name, "cmux_race");
assert(raceTool.parameters.properties.runnerCommands, "tool must accept runnerCommands");
console.log("✓ Tool 'cmux_race' and command '/cmux-race' verified");

// 2. Race Execution Logic Test (simulated runners with fast finish)
console.log("Running simulated race test...");
// runner-1 finishes in 200ms with exit 0; runner-2 finishes in 1500ms
const res = await runCmuxRace(
  "Test race speed",
  [
    'echo "runner 1 solution" && sleep 0.2 && exit 0',
    'echo "runner 2 solution" && sleep 1.5 && exit 0',
  ],
  undefined,
  10,
  cwd
);

assert(res.winner, "Race must have a winner");
assert.equal(res.winner.name, "runner-1", "Fastest runner (runner-1) must win");
assert(res.winner.log.includes("runner 1 solution"), "Winner log must be captured");
console.log("✓ Race-and-Notify verified: runner-1 won in", res.winner.durationMs, "ms");
console.log("  Winner command:", res.winner.command);

// 3. Verification Command Gate Test
console.log("Testing verifyCommand gate in race...");
const verifyRes = await runCmuxRace(
  "Test verifyCommand gate",
  [
    'echo "candidate patch" && exit 0',
  ],
  'node -e "process.exit(0)"', // Passing verification
  10,
  cwd
);

assert(verifyRes.winner, "Verified runner must be accepted");
console.log("✓ Winner verification command passed cleanly");

// Cleanup
fs.rmSync(cwd, { recursive: true, force: true });

console.log("\nALL TESTS PASSED! pi-cmux-race is fully verified.");
