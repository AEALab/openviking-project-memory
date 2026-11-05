import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertSessionRoute, clearState, connectionScope, getStateDir, listStates, loadState, saveState, withSessionLock } from "./session-state.mjs";

const local = { baseUrl: "https://local.invalid", apiKey: "synthetic-local", captureTimeoutMs: 1000 };
const team = { baseUrl: "https://team.invalid", apiKey: "synthetic-team", captureTimeoutMs: 1000 };

async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), "ov-state-safety-"));
  const previous = process.env.OPENVIKING_CODEX_STATE_DIR;
  process.env.OPENVIKING_CODEX_STATE_DIR = path;
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENVIKING_CODEX_STATE_DIR;
    else process.env.OPENVIKING_CODEX_STATE_DIR = previous;
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function isolatedState(t, source) {
  const home = await mkdtemp(join(tmpdir(), "ov-state-url-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENVIKING_") || key.startsWith("NODE_")) delete env[key];
  }
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
    import { existsSync } from "node:fs";
    import { homedir } from "node:os";
    import { join } from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    const { assertSessionRoute, clearState, connectionScope, getStateDir, listStates,
      loadState, saveState, withSessionLock } = await import(${JSON.stringify(new URL("./session-state.mjs", import.meta.url).href)});
    const raw = { baseUrl: "https://TEAM.invalid:443/Api/", apiKey: "synthetic-team",
      account: "account-a", user: "user-a", captureTimeoutMs: 1000 };
    const equivalent = { ...raw, baseUrl: "https://team.invalid/Api" };
    const legacyScope = createHash("sha256").update(JSON.stringify([
      raw.baseUrl, raw.apiKey, raw.account, raw.user])).digest("hex").slice(0, 16);
    const root = join(homedir(), ".openviking", "codex-plugin-state");
    const legacyDir = join(root, legacyScope);
    const canonicalDir = getStateDir(raw);
    const routePath = (id) => join(root, "routes", id + ".json");
    const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
    async function legacy(id) {
      await mkdir(join(root, "routes"), { recursive: true });
      await mkdir(legacyDir, { recursive: true });
      await writeFile(routePath(id), JSON.stringify({ scope: legacyScope }));
      const state = { codexSessionId: id, capturedTurnCount: 7, lastUpdatedAt: 123 };
      await writeFile(join(legacyDir, id + ".json"), JSON.stringify(state));
      return state;
    }
    ${source}
  `], { cwd: home, env, encoding: "utf8", timeout: 10000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("fixed request identity controls state even when ambient credentials change", async (t) => {
  const path = await fixture(t);
  const previous = process.env.OPENVIKING_CLI_CONFIG_FILE;
  process.env.OPENVIKING_CLI_CONFIG_FILE = join(path, "missing-client");
  t.after(() => {
    if (previous === undefined) delete process.env.OPENVIKING_CLI_CONFIG_FILE;
    else process.env.OPENVIKING_CLI_CONFIG_FILE = previous;
  });
  const state = await loadState("bound", local);
  state.capturedTurnCount = 2;
  await saveState(state, { cfg: local });
  assert.equal(getStateDir(local), path);
  assert.equal((await loadState("bound", local)).capturedTurnCount, 2);
  assert.throws(() => assertSessionRoute("bound", team), /connection changed/);
});

test("a shared override never lists or deletes another connection's cursor", async (t) => {
  const path = await fixture(t);
  await saveState({ ...(await loadState("local", local)), capturedTurnCount: 2 }, { cfg: local });
  await saveState(await loadState("team", team), { cfg: team });
  assert.deepEqual((await listStates(team)).map((s) => s.codexSessionId), ["team"]);
  await assert.rejects(clearState("local", team), /unverified/);
  assert.equal((await loadState("local", local)).capturedTurnCount, 2);
  await writeFile(join(path, "unassigned.json"), JSON.stringify({ codexSessionId: "unassigned", capturedTurnCount: 10 }));
  assert.deepEqual((await listStates(local)).map((s) => s.codexSessionId), ["local"]);
  await assert.rejects(loadState("unassigned", local), /no verified connection/);
});

test("concurrent state writers serialize the whole cursor transaction and release locks", async (t) => {
  const path = await fixture(t);
  let active = 0;
  const transaction = () => withSessionLock("shared", local, async () => {
    assert.equal(active++, 0);
    const state = await loadState("shared", local);
    await delay(40);
    state.capturedTurnCount++;
    await saveState(state, { cfg: local });
    active--;
  });
  await Promise.all([transaction(), transaction()]);
  assert.equal((await loadState("shared", local)).capturedTurnCount, 2);
  await assert.rejects(withSessionLock("shared", local, async () => { throw new Error("synthetic failure"); }), /synthetic failure/);
  await assert.rejects(readFile(join(path, "shared.lock")), { code: "ENOENT" });
});

test("corrupt cursors are preserved instead of resetting and replaying history", async (t) => {
  const path = await fixture(t);
  await saveState(await loadState("corrupt", local), { cfg: local });
  await writeFile(join(path, "corrupt.json"), "{");
  await assert.rejects(loadState("corrupt", local), /Invalid OpenViking session state/);
  assert.equal(await readFile(join(path, "corrupt.json"), "utf8"), "{");
});

test("an abandoned session lock is reported and preserved for verified recovery", async (t) => {
  const path = await fixture(t);
  const lock = join(path, "abandoned.lock");
  const content = JSON.stringify({ pid: 2147483647 });
  await writeFile(lock, content);
  await assert.rejects(withSessionLock("abandoned", local, async () => {
    assert.fail("an abandoned lock must not be bypassed");
  }), { code: "OV_SESSION_LOCKED" });
  assert.equal(await readFile(lock, "utf8"), content);
});

test("first routes are complete when published and a concurrent winner is never replaced", async (t) => {
  const path = await fixture(t), routes = join(path, "routes");
  const published = join(routes, "published.json"), winner = join(routes, "winner.json");
  const write = fs.writeFileSync, link = fs.linkSync;
  let observed = false;
  const observe = () => {
    observed = true;
    assert.deepEqual(JSON.parse(fs.readFileSync(published, "utf8")), { scope: connectionScope(local) });
    assert.doesNotThrow(() => assertSessionRoute("published", local));
    assert.throws(() => assertSessionRoute("published", team), /connection changed/);
  };
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fs, "writeFileSync", (file, data, options) => {
    if (file === published) {
      // Expose the empty-file window of a direct final-path write deterministically.
      write(file, "", options);
      observe();
      return write(file, data, { ...options, flag: "w" });
    }
    return write(file, data, options);
  });
  const winningRoute = JSON.stringify({ scope: connectionScope(team) });
  t.mock.method(fs, "linkSync", (source, destination) => {
    if (destination === winner) write(winner, winningRoute, { flag: "wx" });
    const result = link(source, destination);
    if (destination === published) observe();
    return result;
  });
  syncBuiltinESMExports();
  await withSessionLock("published", local, async () => {});
  assert.equal(observed, true);
  await assert.rejects(withSessionLock("winner", local, async () => assert.fail()), /connection changed/);
  assert.equal(await readFile(winner, "utf8"), winningRoute);
  assert.doesNotThrow(() => assertSessionRoute("winner", team));
  assert.deepEqual(fs.readdirSync(routes).sort(), ["published.json", "winner.json"]);
  await assert.rejects(readFile(join(path, "winner.lock")), { code: "ENOENT" });
});

test("canonical URL identity enriches a legacy route without moving its cursor or lock", async (t) => {
  await isolatedState(t, `
    const original = await legacy("legacy");
    assert.notEqual(legacyScope, connectionScope(raw));
    assert.equal(connectionScope(raw), connectionScope(equivalent));
    const lock = join(legacyDir, "legacy.lock");
    const owner = JSON.stringify({ pid: 2147483647 });
    await writeFile(lock, owner);
    await assert.rejects(withSessionLock("legacy", raw, async () => {
      assert.fail("the original lock must not be bypassed");
    }), { code: "OV_SESSION_LOCKED" });
    assert.deepEqual(await readJson(routePath("legacy")), {
      scope: legacyScope, identity: connectionScope(raw)
    });
    assert.equal(await readFile(lock, "utf8"), owner);
    assert.deepEqual(await readJson(join(legacyDir, "legacy.json")), original);
    assert.equal(existsSync(join(canonicalDir, "legacy.lock")), false);
    await rm(lock);
    const state = await loadState("legacy", equivalent);
    assert.equal(state.capturedTurnCount, 7);
    state.capturedTurnCount++;
    await saveState(state, { cfg: equivalent, touch: false });
    assert.equal((await readJson(join(legacyDir, "legacy.json"))).capturedTurnCount, 8);
    assert.equal((await readJson(join(legacyDir, "legacy.json"))).lastUpdatedAt, 123);
    assert.equal(existsSync(join(canonicalDir, "legacy.json")), false);
    assert.ok(!(await readdir(join(root, "routes"))).some((name) => name.endsWith(".tmp")));
    await clearState("legacy", equivalent);
    assert.equal(existsSync(join(legacyDir, "legacy.json")), false);
  `);
});

test("equivalent URL writers share the original legacy lock and cursor", async (t) => {
  await isolatedState(t, `
    await legacy("shared-url");
    let active = 0;
    const transaction = (cfg) => withSessionLock("shared-url", cfg, async () => {
      assert.equal(active++, 0);
      assert.equal(existsSync(join(legacyDir, "shared-url.lock")), true);
      assert.equal(existsSync(join(canonicalDir, "shared-url.lock")), false);
      const state = await loadState("shared-url", cfg);
      await delay(40);
      state.capturedTurnCount++;
      await saveState(state, { cfg });
      active--;
    });
    await Promise.all([transaction(raw), transaction(equivalent)]);
    assert.equal((await loadState("shared-url", equivalent)).capturedTurnCount, 9);
    assert.equal(existsSync(join(legacyDir, "shared-url.lock")), false);
    await saveState(await loadState("new-url", raw), { cfg: equivalent });
    assert.equal(getStateDir(raw), getStateDir(equivalent));
    assert.deepEqual(await readJson(routePath("new-url")), { scope: connectionScope(raw) });
    assert.equal(existsSync(join(canonicalDir, "new-url.json")), true);
  `);
});

test("first listing finds an unenriched legacy cursor and ignores its stale canonical copy", async (t) => {
  await isolatedState(t, `
    const original = await legacy("idle");
    await mkdir(canonicalDir, { recursive: true });
    await writeFile(join(canonicalDir, "idle.json"), JSON.stringify({ ...original, capturedTurnCount: 999 }));
    assert.deepEqual(await listStates(raw), [original]);
    assert.deepEqual(await readJson(routePath("idle")), { scope: legacyScope });
    assertSessionRoute("idle", raw);
    assert.deepEqual(await listStates(equivalent), [original]);
    assert.equal((await readJson(join(canonicalDir, "idle.json"))).capturedTurnCount, 999);
  `);
});

test("legacy URL aliases require original verification and changed identities remain refused", async (t) => {
  await isolatedState(t, `
    const original = await legacy("unverified");
    const originalRoute = await readFile(routePath("unverified"), "utf8");
    await assert.rejects(loadState("unverified", equivalent), /connection changed/);
    await assert.rejects(withSessionLock("unverified", equivalent, async () => assert.fail()), /connection changed/);
    assert.deepEqual(await listStates(equivalent), []);
    assert.equal(await readFile(routePath("unverified"), "utf8"), originalRoute);
    assert.equal(existsSync(join(canonicalDir, "unverified.lock")), false);
    assertSessionRoute("unverified", raw);
    for (const cfg of [
      { ...equivalent, apiKey: "another-key" }, { ...equivalent, account: "account-b" },
      { ...equivalent, user: "user-b" }, { ...equivalent, baseUrl: "https://team.invalid/api" }
    ]) {
      assert.notEqual(connectionScope(cfg), connectionScope(raw));
      await assert.rejects(loadState("unverified", cfg), /connection changed/);
      await assert.rejects(clearState("unverified", cfg), /unverified/);
      assert.deepEqual(await listStates(cfg), []);
    }
    await legacy("wrong-identity");
    await writeFile(routePath("wrong-identity"), JSON.stringify({ scope: legacyScope, identity: "0000000000000000" }));
    await assert.rejects(loadState("wrong-identity", raw), /connection changed/);
    await legacy("unknown-scope");
    await writeFile(routePath("unknown-scope"), JSON.stringify({ scope: "0000000000000000" }));
    await assert.rejects(loadState("unknown-scope", raw), /connection changed/);
    assert.deepEqual(await readJson(join(legacyDir, "unverified.json")), original);
  `);
});

test("an explicit state-directory override keeps legacy cursors at the override root", async (t) => {
  const path = await fixture(t);
  const raw = { ...team, baseUrl: "https://TEAM.invalid:443/" };
  const equivalent = { ...raw, baseUrl: "https://team.invalid" };
  const scope = createHash("sha256").update(JSON.stringify([
    raw.baseUrl, raw.apiKey, raw.account, raw.user,
  ])).digest("hex").slice(0, 16);
  await mkdir(join(path, "routes"));
  await writeFile(join(path, "routes", "override.json"), JSON.stringify({ scope }));
  await writeFile(join(path, "override.json"), JSON.stringify({ codexSessionId: "override", capturedTurnCount: 4 }));
  assertSessionRoute("override", raw);
  assert.equal(getStateDir(equivalent), path);
  await withSessionLock("override", equivalent, async () => {
    assert.equal(JSON.parse(await readFile(join(path, "override.lock"), "utf8")).pid, process.pid);
    const state = await loadState("override", equivalent);
    assert.equal(state.capturedTurnCount, 4);
    await saveState({ ...state, capturedTurnCount: 5 }, { cfg: equivalent });
  });
  assert.deepEqual(JSON.parse(await readFile(join(path, "routes", "override.json"), "utf8")), {
    scope, identity: connectionScope(equivalent),
  });
  assert.equal((await listStates(equivalent))[0].capturedTurnCount, 5);
  await clearState("override", equivalent);
  await assert.rejects(readFile(join(path, "override.json")), { code: "ENOENT" });
});
