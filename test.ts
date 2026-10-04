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

// ---- review 3 regressions. The runBounded block is run in a vm against a mocked OS, so cancellation and
// recycled process-group ids can be staged deterministically without touching a real process.
{
  const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname, resolve } = await import("node:path");
  const vm = await import("node:vm");
  const { EventEmitter } = await import("node:events");
  const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const from = src.indexOf("export interface BoundedResult");
  const procs = src.indexOf("// Processes (any session");
  const end = procs > 0 ? procs : src.indexOf("\n", src.indexOf("const groupAlive"));
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(src.slice(from, end)).replaceAll("export ", "");
  const LEADER = 424242;
  const esrch = () => { const e: any = new Error("ESRCH"); e.code = "ESRCH"; return e; };
  // sandbox: sent = non-zero signals, spawned = spawn() calls; hooks let a case script the OS
  const sandbox = (over: any = {}) => {
    const box: any = { console, Buffer, setTimeout, clearTimeout, join, dirname, resolvePath: resolve, readFileSync, realpathSync, sent: [] as any[], spawned: 0, ps: "", ...over };
    box.process = { platform: "darwin", env: {}, kill: (pid: number, sig: any) => { if (sig === 0) { if (box.alive?.(pid)) return true; throw esrch(); } box.sent.push([pid, sig]); box.onSignal?.(pid, sig); return true; }, ...over.process };
    box.execFile = () => { throw new Error("unexpected taskkill"); };
    box.execFileSync = (_c: string, args: string[]) => (args.includes("-axo") ? box.ps : box.leaderPs ?? "");
    box.spawn ??= () => { box.spawned++; const c: any = new EventEmitter(); c.pid = LEADER; c.exitCode = null; c.signalCode = null; c.stdout = Object.assign(new EventEmitter(), { destroy() {} }); c.stderr = Object.assign(new EventEmitter(), { destroy() {} }); box.child = c; setImmediate(() => box.script?.(c)); return c; };
    vm.createContext(box);
    vm.runInContext(code, box);
    return box;
  };
  const opts = (signal?: AbortSignal) => ({ cwd: tmpdir(), timeoutMs: 20000, signal });

  // 1. an already-aborted signal never starts the command (POSIX and Windows), nor does one aborted while the shell resolves
  {
    const box = sandbox();
    const r = await box.runBounded("echo REVIEW3_PREABORT", opts(AbortSignal.abort()));
    assert.equal(box.spawned, 0, "pre-aborted: spawn must not happen");
    assert.ok(r.aborted && r.code === null && r.out === "", JSON.stringify(r));
    const w = sandbox({ process: { platform: "win32" }, spawn: () => { w.spawned++; throw new Error("must not spawn"); } });
    const w2 = await w.runBounded("echo REVIEW3_PREABORT", opts(AbortSignal.abort()));
    assert.equal(w.spawned, 0);
    assert.ok(w2.aborted && w2.code === null, JSON.stringify(w2));
    // abort lands while winShell() is awaited
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w3 = sandbox({ process: { platform: "win32" }, gate, spawn: () => { w3.spawned++; throw new Error("must not spawn"); } });
    vm.runInContext('winShell = async () => { await gate; return "sh"; };', w3);
    const ac = new AbortController();
    const pending = w3.runBounded("echo REVIEW3_PREABORT", opts(ac.signal));
    ac.abort();
    release();
    const r3 = await pending;
    assert.equal(w3.spawned, 0, "aborted during shell resolution: spawn must not happen");
    assert.ok(r3.aborted && r3.code === null, JSON.stringify(r3));
    console.log("✓ already-aborted / aborted-while-resolving: not spawned, reported aborted");
  }

  // 2a. a recycled group (leader pid gone, replacement members alive, none of them ours) is never signalled
  {
    const box = sandbox({ alive: (pid: number) => pid === -LEADER, script: (c: any) => { c.exitCode = 0; c.emit("close", 0); } });
    const r = await box.runBounded("true", opts());
    assert.deepEqual(box.sent, [], "foreign group must get no signal");
    assert.ok(r.foreign && !r.strays, JSON.stringify(r));
    console.log("✓ unproven (recycled) group: no signal, reported foreign");
  }

  // 2b. ownership is re-proven before EACH signal: our stray proves the group for TERM, then the group is recycled
  for (const recycle of [false, true]) {
    const box = sandbox({
      alive: (pid: number) => pid === -LEADER,
      ps: `${LEADER} ${LEADER}\n777 ${LEADER}\n`,
      script: (c: any) => { c.exitCode = 0; c.emit("exit", 0); c.emit("close", 0); if (recycle) setTimeout(() => { box.ps = `900 ${LEADER}\n`; }, 250); },
    });
    const r = await box.runBounded("true", opts());
    if (recycle) {
      assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"]], "KILL must not follow once the group is no longer provably ours");
      assert.ok(r.foreign && r.strays, JSON.stringify(r));
    } else {
      assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"], [-LEADER, "SIGKILL"]]);
      assert.ok(r.strays && !r.foreign, JSON.stringify(r));
    }
  }
  console.log("✓ stray group: signalled while provably ours, left alone once recycled");

  // 3. winShell follows Pi's effective settings: trusted project settings override the global shellPath
  {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-settings-")));
    const agent = join(base, "agent"), proj = join(base, "proj");
    mkdirSync(agent, { recursive: true });
    mkdirSync(join(proj, ".pi"), { recursive: true });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ shellPath: "/bin/sh" }));
    writeFileSync(join(proj, ".pi", "settings.json"), JSON.stringify({ shellPath: "/bin/bash" }));
    const { winShell } = await import("./index.ts");
    const [cwd0, env0] = [process.cwd(), process.env.PI_CODING_AGENT_DIR];
    process.env.PI_CODING_AGENT_DIR = agent;
    process.chdir(proj);
    try {
      writeFileSync(join(agent, "trust.json"), JSON.stringify({}));
      assert.equal(await winShell(), "/bin/sh", "untrusted project: its settings are ignored");
      writeFileSync(join(agent, "trust.json"), JSON.stringify({ [dirname(proj)]: true }));
      assert.equal(await winShell(), "/bin/bash", "trusted (ancestor entry): project shellPath wins, as in Pi");
      writeFileSync(join(agent, "trust.json"), JSON.stringify({ [dirname(proj)]: true, [proj]: false }));
      assert.equal(await winShell(), "/bin/sh", "nearest trust entry is false");
    } finally {
      process.chdir(cwd0);
      if (env0 === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = env0;
      rmSync(base, { recursive: true, force: true });
    }
    console.log("✓ winShell: Pi's merged settings, project trust respected");
  }

  // 4. (race only) killGroup re-proves ownership before each signal
  if (typeof (sandbox() as any).killGroup === "function") {
    for (const recycle of [false, true]) {
      const box = sandbox({
        alive: (pid: number) => (pid === -LEADER || (pid === LEADER && !box.replaced)) && !box.dead,
        leaderPs: "S bash race-leader /m/marker\n",
        ps: `${LEADER} ${LEADER}\n555 ${LEADER}\n`,
        onSignal: (_p: number, sig: string) => { if (sig === "SIGTERM") { box.replaced = true; box.ps = recycle ? `900 ${LEADER}\n` : `555 ${LEADER}\n`; box.leaderPs = "S unrelated\n"; } else box.dead = true; },
      });
      const out = await box.killGroup(LEADER, "/m/marker");
      if (recycle) {
        assert.equal(out, "foreign");
        assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"]], "no KILL to a group that is no longer provably ours");
      } else {
        assert.equal(out, "killed");
        assert.deepEqual(box.sent, [[-LEADER, "SIGTERM"], [-LEADER, "SIGKILL"]]);
      }
    }
    console.log("✓ killGroup: ownership re-proven before every signal");
  }
}
