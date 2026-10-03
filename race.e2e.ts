// Real race loop, real git worktrees, fake cmux (runs --command in the background instead of a pane).
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCmuxRace } from "./index.ts";

delete process.env.TYPESAFE_API_KEY;
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "race-e2e-")));
const fake = join(tmp, "fake-cmux");
const callLog = join(tmp, "cmux-calls.log");
writeFileSync(fake, `#!/bin/bash
echo "$1" >> '${callLog}'
if [ "$1" = new-split ]; then
  while [ $# -gt 0 ]; do [ "$1" = --command ] && { nohup bash -c "$2" >/dev/null 2>&1 & break; }; shift; done
  echo "OK surface:9 $(uuidgen)"
fi
exit 0
`, { mode: 0o755 });
process.env.PI_CMUX_BIN = fake;

const repo = join(tmp, "repo");
const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
execFileSync("mkdir", ["-p", repo]);
g("init", "-q", "-b", "main");
writeFileSync(join(repo, "README"), "x\n");
g("add", "README");
g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");

const verifyLog = join(tmp, "verify.log");
const r = await runCmuxRace(
  "make out.txt say good",
  [
    "sleep 0.2; echo bad > out.txt", // finishes first, wrong answer
    "sleep 1.5; echo good > out.txt", // slower, right answer
    "echo ')' ; exit 1", // unbalanced paren must not break the wrapper; nonzero exit never wins
  ],
  `echo "$(basename "$PWD")" >> '${verifyLog}'; grep -q good out.txt`,
  20,
  repo,
);
assert.equal(r.error, undefined, r.error);
assert.equal(r.isolated, true);
assert.equal(r.winner!.name, "runner-2", "isolated verify must reject the fast wrong runner");
assert.equal(readFileSync(join(r.winner!.worktree!, "out.txt"), "utf8").trim(), "good");
assert.ok(!existsSync(join(repo, "out.txt")), "runners must not touch the caller's checkout");
const verified = readFileSync(verifyLog, "utf8").trim().split("\n");
assert.equal(verified.filter((v) => v === "runner-1").length, 1, "a failed candidate is verified exactly once");
const wts = g("worktree", "list").split("\n");
assert.equal(wts.length, 2, `only main + winner worktree remain, got:\n${wts.join("\n")}`);
console.log("✓ isolated worktrees: wrong-but-fast runner rejected once, winner kept, losers removed, checkout untouched");
g("worktree", "remove", "--force", r.winner!.worktree!);

// Timeout: nothing finishes -> error, all worktrees removed
const t = await runCmuxRace("never", ["sleep 30", "sleep 30"], undefined, 5, repo);
assert.match(t.error ?? "", /timed out/);
assert.equal(g("worktree", "list").split("\n").length, 1, "timeout must remove every worktree");
console.log("✓ timeout: error reported, every worktree removed");

// Non-git directory: shared cwd, reported as not isolated
const plain = join(tmp, "plain");
execFileSync("mkdir", ["-p", plain]);
const n = await runCmuxRace("plain", ["true", "sleep 5"], undefined, 10, plain);
assert.equal(n.winner!.name, "runner-1");
assert.equal(n.isolated, false);
console.log("✓ non-git cwd runs shared and says so");
const g2 = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const pg = (pat: string) => { try { return execFileSync("pgrep", ["-f", pat], { encoding: "utf8" }).trim(); } catch { return ""; } };

// Orphans: fake close-surface kills nothing, so only the extension's own teardown can stop runners
const o = await runCmuxRace("orphans", ["sleep 31.7", "sleep 31.7"], undefined, 5, repo);
assert.match(o.error ?? "", /timed out/);
await new Promise((r) => setTimeout(r, 300));
assert.equal(pg("sleep 31.7"), "", "runners must be killed even when pane closure does nothing");
console.log("✓ unfinished runners killed by the extension (pane closure not trusted)");

// Verify that ignores SIGTERM: no winner, bounded by deadline + kill escalation, no stragglers
const v = await runCmuxRace("stubborn verify", ["true"], "trap '' TERM; sleep 4.3", 5, repo);
assert.ok(!v.winner, "a verify that outlives the deadline must not produce a winner");
assert.ok(v.durationMs < 9500, `race not bounded: ${v.durationMs} ms`);
await new Promise((r) => setTimeout(r, 300));
assert.equal(pg("sleep 4.3"), "", "verify process group must be killed");
console.log(`✓ TERM-ignoring verify: no winner, bounded (${v.durationMs} ms), group killed`);

// Nested cwd: worktree reported is the ROOT (git worktree remove accepts it)
execFileSync("mkdir", ["-p", join(repo, "sub/dir")]);
writeFileSync(join(repo, "sub/dir/.keep"), ""); g("add", "sub"); g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "sub"); // worktrees come from HEAD
const nested = await runCmuxRace("nested", ["pwd > where.txt"], undefined, 10, join(repo, "sub/dir"));
assert.ok(nested.winner!.worktree, "winner worktree reported");
assert.ok(existsSync(join(nested.winner!.worktree!, "sub/dir/where.txt")), "runner ran in the nested dir of its worktree");
g2(repo, "worktree", "remove", "--force", nested.winner!.worktree!); // throws if not a worktree root
console.log("✓ nested cwd: runner ran in sub/dir, reported path is the worktree root");

// Fail closed: worktree creation impossible -> error, no panes, checkout untouched
const before = readFileSync(callLog, "utf8").split("\n").filter((l) => l === "new-split").length;
execFileSync("bash", ["-c", "rm -rf .git/worktrees && touch .git/worktrees"], { cwd: repo });
const f = await runCmuxRace("no isolation possible", ["echo pwned > pwned.txt", "true"], undefined, 10, repo);
execFileSync("rm", ["-f", join(repo, ".git/worktrees")]);
assert.match(f.error ?? "", /isolated worktree/);
assert.ok(!existsSync(join(repo, "pwned.txt")), "must never run in the caller's checkout");
assert.equal(readFileSync(callLog, "utf8").split("\n").filter((l) => l === "new-split").length, before, "no panes spawned");
const empty = join(tmp, "empty");
execFileSync("mkdir", ["-p", empty]); g2(empty, "init", "-q");
const e = await runCmuxRace("no commits", ["true", "true"], undefined, 10, empty);
assert.match(e.error ?? "", /no commits/);
console.log("✓ fail closed: worktree failure and commitless repo refuse to run (no panes, checkout untouched)");

console.log("\nRACE E2E PASSED");
