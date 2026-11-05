import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { assertSessionRoute, clearState, getStateDir, listStates, loadState, saveState, withSessionLock } from "./session-state.mjs";

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
