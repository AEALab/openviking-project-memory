// Community modification: connection-bound state and serialized session writes.
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveOpenVikingCredentials } from "./ov-credentials.mjs";
import { deriveCodexSessionId } from "./shared/session-model.mjs";
import { normalizeConnectionUrl } from "./read-routing.mjs";

const DEFAULT_STATE_DIR = join(homedir(), ".openviking", "codex-plugin-state");

function hashConnection(cfg, baseUrl) {
  return createHash("sha256")
    .update(JSON.stringify([baseUrl, cfg.apiKey, cfg.account, cfg.user]))
    .digest("hex").slice(0, 16);
}

export function connectionScope(cfg = resolveOpenVikingCredentials()) {
  return hashConnection(cfg, normalizeConnectionUrl(cfg.baseUrl).replace(/\/+$/, ""));
}

export function getStateDir(cfg) {
  return process.env.OPENVIKING_CODEX_STATE_DIR || join(DEFAULT_STATE_DIR, connectionScope(cfg));
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
}

function routePath(id) {
  return join(process.env.OPENVIKING_CODEX_STATE_DIR || DEFAULT_STATE_DIR, "routes", safeId(id) + ".json");
}

function statePath(id, cfg) {
  return join(stateDirectory(id, cfg), safeId(id) + ".json");
}

function readRoute(id) {
  try { return JSON.parse(readFileSync(routePath(id), "utf8")); }
  catch { return null; }
}

function routeMatches(route, cfg) {
  if (typeof route?.scope !== "string" || !/^[a-f0-9]{16}$/.test(route.scope)) return false;
  const identity = connectionScope(cfg);
  return route.identity === undefined
    ? route.scope === identity || route.scope === hashConnection(cfg, cfg.baseUrl)
    : route.identity === identity;
}

function stateDirectory(id, cfg) {
  const route = readRoute(id);
  return process.env.OPENVIKING_CODEX_STATE_DIR
    || join(DEFAULT_STATE_DIR, routeMatches(route, cfg) ? route.scope : connectionScope(cfg));
}

function matchesRoute(id, cfg) {
  return routeMatches(readRoute(id), cfg);
}

export function assertSessionRoute(id, cfg = resolveOpenVikingCredentials()) {
  const path = routePath(id);
  const root = process.env.OPENVIKING_CODEX_STATE_DIR || DEFAULT_STATE_DIR;
  if (!existsSync(path) && (existsSync(statePath(id, cfg))
    || existsSync(join(root, hashConnection(cfg, cfg.baseUrl), safeId(id) + ".json"))
    || existsSync(join(root, safeId(id) + ".json")))) {
    throw new Error("Legacy OpenViking session has no verified connection; start a new Codex conversation.");
  }
  mkdirSync(join(root, "routes"), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ scope: connectionScope(cfg) }), { flag: "wx", mode: 0o600 });
      try { linkSync(temporary, path); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally { rmSync(temporary, { force: true }); }
  }
  if (!matchesRoute(id, cfg)) {
    throw new Error("OpenViking connection changed for this session; start a new Codex conversation.");
  }
  const route = readRoute(id);
  if (route.identity === undefined && route.scope !== connectionScope(cfg)) {
    // Retain the old directory and lock; only add a verified canonical identity.
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ ...route, identity: connectionScope(cfg) }), { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
  }
}

export function deriveOvSessionId(id) {
  return deriveCodexSessionId(id);
}

export function resolveOvSessionId(state) {
  state.ovSessionId = deriveOvSessionId(state.codexSessionId);
  return state.ovSessionId;
}

function defaultState(id) {
  const now = Date.now();
  return { codexSessionId: id, ovSessionId: null, workspacePeerId: "",
    capturedTurnCount: 0, createdAt: now, lastUpdatedAt: now };
}

export async function loadState(id, cfg = resolveOpenVikingCredentials()) {
  assertSessionRoute(id, cfg);
  try {
    const parsed = JSON.parse(await readFile(statePath(id, cfg), "utf8"));
    if (parsed.codexSessionId !== id) throw new Error("Invalid OpenViking session state");
    return { ...defaultState(id), ...parsed };
  } catch (error) {
    if (error.code === "ENOENT") return defaultState(id);
    // A broken cursor must not cause a complete history replay.
    throw new Error("Invalid OpenViking session state; preserve it and start a new conversation.");
  }
}

export async function saveState(state, { touch = true, cfg = resolveOpenVikingCredentials() } = {}) {
  if (!state?.codexSessionId) return;
  assertSessionRoute(state.codexSessionId, cfg);
  await mkdir(getStateDir(cfg), { recursive: true, mode: 0o700 });
  const next = { ...state,
    lastUpdatedAt: touch || typeof state.lastUpdatedAt !== "number" ? Date.now() : state.lastUpdatedAt };
  const final = statePath(state.codexSessionId, cfg);
  const tmp = final + "." + randomUUID() + ".tmp";
  try {
    await writeFile(tmp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    await rename(tmp, final);
  } finally { await rm(tmp, { force: true }); }
}

export async function clearState(id, cfg = resolveOpenVikingCredentials()) {
  if (!matchesRoute(id, cfg)) throw new Error("Refusing to delete an unverified OpenViking session.");
  await rm(statePath(id, cfg), { force: true });
}

export async function listStates(cfg = resolveOpenVikingCredentials()) {
  const directories = new Set([getStateDir(cfg)]);
  if (!process.env.OPENVIKING_CODEX_STATE_DIR) {
    let routes;
    try { routes = await readdir(join(DEFAULT_STATE_DIR, "routes")); }
    catch (error) { if (error.code === "ENOENT") routes = []; else throw error; }
    for (const file of routes) {
      if (!file.endsWith(".json")) continue;
      const route = readRoute(file.slice(0, -5));
      if (routeMatches(route, cfg)) directories.add(join(DEFAULT_STATE_DIR, route.scope));
    }
  }
  const states = [];
  for (const directory of directories) {
    let files;
    try { files = await readdir(directory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await readFile(join(directory, file), "utf8"));
        if (value?.codexSessionId && file === safeId(value.codexSessionId) + ".json"
          && matchesRoute(value.codexSessionId, cfg) && stateDirectory(value.codexSessionId, cfg) === directory) states.push(value);
      } catch { /* Unreadable or unassigned states are preserved, never replayed or retired. */ }
    }
  }
  return states;
}

export async function withSessionLock(id, cfg, action) {
  assertSessionRoute(id, cfg);
  const directory = stateDirectory(id, cfg);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, safeId(id) + ".lock");
  const deadline = Date.now() + Math.min(Number(cfg?.captureTimeoutMs) || 20000, 20000);
  let handle;
  while (!handle) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (handle) { await handle.close(); await rm(path, { force: true }); throw error; }
      if (error.code !== "EEXIST") throw error;
      let abandoned = false;
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) { abandoned = probe.code === "ESRCH"; }
        }
      } catch { /* The owner may still be writing its PID. */ }
      if (abandoned || Date.now() >= deadline) {
        const failure = new Error("OpenViking session lock is busy or abandoned; retry, or verify the lock PID before removing " + path);
        failure.code = "OV_SESSION_LOCKED";
        throw failure;
      }
      await delay(25);
    }
  }
  try {
    assertSessionRoute(id, cfg);
    return await action();
  } finally {
    const owned = await handle.stat();
    await handle.close();
    try {
      const current = await stat(path);
      if (current.ino === owned.ino && current.dev === owned.dev) await rm(path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
