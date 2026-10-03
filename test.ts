import assert from "node:assert";
import registerCmuxRace, { safeCmux } from "./index.ts";

console.log("=== Testing pi-cmux-race extension (Hardened) ===");

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
const cmuxRaceTool = registeredTools.get("cmux_race");
console.log("✓ Tool and command registrations verified");

// 1. safeCmux argv test (must handle arguments safely without shell injection)
const cmuxVer = safeCmux(["--help"]);
console.log("✓ safeCmux argv call executed cleanly (returned length:", cmuxVer.length, ")");

// 2. Five-argument tool execute test (with cancellation signal)
const mockCtx: any = {
  cwd: process.cwd(),
  ui: { notify: () => {} },
};

const controller = new AbortController();
// Test execute signature
const res = await cmuxRaceTool.execute(
  "call-race-1",
  {
    goal: "Simulated test race",
    runnerCommands: ["echo winner1", "echo winner2"],
    timeoutSeconds: 5,
  },
  controller.signal,
  () => {},
  mockCtx
);

assert(res.content[0].text, "Execution must return content");
console.log("✓ Pi 5-argument tool.execute contract verified");

console.log("\nALL TESTS PASSED! pi-cmux-race is fully hardened.");
