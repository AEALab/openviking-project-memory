// Community modification (2026-11-05): shared read-mode command and directory validation.
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
const CLI = fileURLToPath(new URL("./ov-memory.mjs", import.meta.url));

function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ov-memory-command-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const project = join(home, "project"), nested = join(project, "nested");
  mkdirSync(nested, { recursive: true });
  const path = join(home, ".openviking", "read-routing.json");
  const local = join(home, "local.conf"), team = join(home, "team.conf");
  const localData = { url: "https://local.invalid", api_key: "fake-local-secret" };
  const teamData = { url: "https://team.invalid", api_key: "fake-team-secret" };
  writeFileSync(local, JSON.stringify(localData)); writeFileSync(team, JSON.stringify(teamData));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENVIKING_")));
  Object.assign(env, { HOME: home, OPENVIKING_CREDENTIAL_SOURCE: "cli", OPENVIKING_CLI_CONFIG_FILE: team });
  const route = (value) => { mkdirSync(join(home, ".openviking"), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
  const run = (args = [], cwd = project, entry = CLI, extraEnv = {}) => {
    const result = spawnSync(process.execPath, [entry, ...args], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    for (const key of [localData.api_key, teamData.api_key]) assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));
    return result;
  };
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const backups = () => existsSync(join(home, ".openviking"))
    ? readdirSync(join(home, ".openviking")).filter((name) => name.startsWith("read-routing.json.backup-")) : [];
  return { home, project, nested, path, local, team, localData, teamData, route, run, read, backups };
}
function unchanged(f, args, expectedStatus = 1) {
  const before = readFileSync(f.path), mtime = statSync(f.path).mtimeMs, backups = f.backups();
  const result = f.run(args); assert.equal(result.status, expectedStatus, result.stderr);
  assert.deepEqual(readFileSync(f.path), before); assert.equal(statSync(f.path).mtimeMs, mtime); assert.deepEqual(f.backups(), backups);
  assert.ok(!readdirSync(join(f.home, ".openviking")).some((name) => name.includes(".tmp-")));
  return result;
}

test("status and missing inherit are read-only; separate needs only the active team config", (t) => {
  const f = fixture(t); rmSync(f.local);
  for (const args of [[], ["status"], ["read", "inherit"]]) {
    const result = f.run(args); assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Global read mode: separate/); assert.match(result.stdout, /missing; default separate/);
    assert.match(result.stdout, /Effective configured read mode: separate/); assert.match(result.stdout, /Write URL: https:\/\/team.invalid/);
    assert.ok(result.stdout.includes("Write configuration origin: " + f.team)); assert.match(result.stdout, /live MCP read mode: unknown/);
    assert.match(result.stdout, /new Codex session or restart Codex/); assert.equal(existsSync(join(f.home, ".openviking")), false);
  }
  assert.equal(f.run(["read", "separate"]).status, 0);
  assert.deepEqual(f.read(), { mode: "separate", directories: { [f.project]: "separate" } });
  assert.equal(statSync(f.path).mode & 0o777, 0o600); assert.deepEqual(f.backups(), []);
});

test("current and global changes preserve sources, unknown fields, and credential bytes", (t) => {
  const f = fixture(t), sources = { local: f.local, team: f.team };
  const credentials = [readFileSync(f.local), readFileSync(f.team)];
  f.route({ mode: "combined", sources, extension: { keep: [1, 2] }, directories: { [f.nested]: "combined" } });
  const before = readFileSync(f.path); const result = f.run(["read", "separate"]);assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.read(), { mode: "combined", sources, extension: { keep: [1, 2] }, directories: { [f.nested]: "combined", [f.project]: "separate" } });
  const backup = join(f.home, ".openviking", f.backups()[0]);assert.match(result.stdout, /Backup:/);
  assert.deepEqual(readFileSync(backup), before); assert.equal(statSync(backup).mode & 0o777, 0o600); assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(f.run(["read", "separate", "--global"]).status, 0); assert.equal(f.read().mode, "separate");
  assert.deepEqual(f.read().directories, { [f.nested]: "combined", [f.project]: "separate" });
  const nested = f.run(["status"], f.nested); assert.equal(nested.status, 0, nested.stderr);
  assert.ok(nested.stdout.includes("Closest directory rule: " + f.nested)); assert.match(nested.stdout, /Effective configured read mode: combined/);
  assert.deepEqual(readFileSync(f.local), credentials[0]); assert.deepEqual(readFileSync(f.team), credentials[1]); assert.equal(f.backups().length, 2);
});

test("inherit removes exact canonical aliases while retaining parent and child rules", (t) => {
  const f = fixture(t), alias = join(f.home, "alias"); symlinkSync(f.project, alias, "dir");
  f.route({ mode: "separate", sources: { local: f.local, team: f.team }, directories: {
    [f.home]: "combined", [f.project]: "separate", [alias]: "separate", "~/project": "separate", [f.nested]: "separate" } });
  const result = f.run(["read", "inherit"], alias);assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.read().directories, { [f.home]: "combined", [f.nested]: "separate" });
  assert.ok(result.stdout.includes("Closest directory rule: " + f.home));assert.match(result.stdout, /Effective configured read mode: combined/);
});

test("no-op changes and absent current inherit preserve original bytes and modification times", (t) => {
  const f = fixture(t);
  f.route(' { "mode": "separate", "extension": 7, "directories": ' + JSON.stringify({ [f.project]: "separate", [f.nested]: "separate" }) + ' }\n');
  unchanged(f, ["read", "separate"], 0); unchanged(f, ["read", "separate", "--global"], 0); unchanged(f, ["status"], 0);
  f.route({ mode: "separate", directories: { [f.home]: "separate" } }); unchanged(f, ["read", "inherit"], 0);
});

test("invalid arguments, JSON, modes and directory rules leave configuration untouched", (t) => {
  const f = fixture(t); f.route({ mode: "separate" });
  for (const args of [["read"], ["read", "wrong"], ["read", "inherit", "--global"], ["status", "--json"], ["read", "separate", "--dir", f.home]]) unchanged(f, args);
  f.route('{ "mode": "separate", "api_key": "fake-team-secret", BROKEN');assert.match(unchanged(f, ["read", "separate"]).stderr, /Invalid.*JSON/);
  for (const value of [null, [], {}, { mode: "wrong" }, { mode: "separate", directories: [] }, { mode: "separate", directories: { relative: "combined" } }, { mode: "separate", directories: { [f.home]: "wrong" } }]) {
    f.route(value === null ? "null" : value); unchanged(f, ["read", "separate"]);
  }
});

test("combined validates sources and identity before directory or global mutations", (t) => {
  const f = fixture(t);f.route({ mode: "separate", directories: { [f.project]: "separate" } });
  unchanged(f, ["read", "combined"]); unchanged(f, ["read", "combined", "--global"]);
  f.route({ mode: "separate", sources: { local: f.local, team: f.team }, directories: { [f.project]: "separate" } });
  writeFileSync(f.team, JSON.stringify({ ...f.teamData, api_key: "foreign-fake-secret" }));
  const result = f.run(["read", "combined"], f.project, CLI, { OPENVIKING_CREDENTIAL_SOURCE: "env", OPENVIKING_URL: "https://team.invalid", OPENVIKING_API_KEY: "unmatched-fake-secret" });
  assert.equal(result.status, 1);assert.ok(!result.stdout.includes("unmatched-fake-secret") && !result.stderr.includes("unmatched-fake-secret"));
  assert.equal(f.read().directories[f.project], "separate");assert.deepEqual(f.backups(), []);
  rmSync(f.local); unchanged(f, ["read", "combined"]);unchanged(f, ["read", "combined", "--global"]);unchanged(f, ["read", "separate"], 0);
});

test("configuration symlinks are refused and command symlinks execute the CLI", (t) => {
  const f = fixture(t), target = join(f.home, "routing-target.json"), entry = join(f.home, "ov-memory");
  f.route({ mode: "separate" });const bytes = readFileSync(f.path);writeFileSync(target, bytes);rmSync(f.path);symlinkSync(target, f.path);
  const result=f.run(["read", "separate"]);assert.equal(result.status, 1);assert.match(result.stderr, /Refusing symlink/);
  assert.equal(lstatSync(f.path).isSymbolicLink(), true);assert.deepEqual(readFileSync(target), bytes);assert.deepEqual(f.backups(), []);
  rmSync(f.path);symlinkSync(CLI, entry);assert.equal(f.run(["status"], f.project, entry).status, 0);
});

test("status redacts URL authentication and reports environment configuration origin", (t) => {
  const f = fixture(t);const result = f.run(["status"], f.project, CLI, {
    OPENVIKING_CREDENTIAL_SOURCE: "env", OPENVIKING_URL: "https://url-user:url-secret@team.invalid/path?token=query-secret#fragment-secret", OPENVIKING_API_KEY: "fake-team-secret" });
  assert.equal(result.status, 0, result.stderr);
  for (const secret of ["url-user", "url-secret", "query-secret", "fragment-secret"]) assert.ok(!result.stdout.includes(secret));
  assert.match(result.stdout, /Write configuration origin: environment/);
});

test("a filesystem save failure preserves the original configuration and leaves no partial output", (t) => {
  const f = fixture(t);f.route({mode:"separate"});const before=readFileSync(f.path);const directory=join(f.home,".openviking");
  chmodSync(directory,0o500);
  try { const result=f.run(["read","separate"]);assert.equal(result.status,1);assert.deepEqual(readFileSync(f.path),before);assert.deepEqual(f.backups(),[]); }
  finally { chmodSync(directory,0o700); }
});


test("an exclusive writer lock prevents overlapping edits and is released after save", (t) => {
  const f=fixture(t);f.route({mode:"separate"});const lock=f.path+".lock";
  writeFileSync(lock,"another-writer",{mode:0o600});
  const denied=unchanged(f,["read","separate"]);
  assert.match(denied.stderr,/locked by another command/);
  assert.equal(readFileSync(lock,"utf8"),"another-writer");
  rmSync(lock);
  const saved=f.run(["read","separate"]);assert.equal(saved.status,0,saved.stderr);
  assert.equal(existsSync(lock),false);assert.equal(f.read().directories[f.project],"separate");
});
