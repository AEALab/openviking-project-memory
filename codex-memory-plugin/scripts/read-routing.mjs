// Community modification (2026-11-05): shared read-mode command and directory validation.
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function readIdentity(config) {
  return JSON.stringify([
    text(config.baseUrl).replace(/\/+$/, ""), text(config.apiKey),
    text(config.account), text(config.user),
  ]);
}

function sourceConfig(name, path, primaryCfg) {
  try {
    const file = JSON.parse(readFileSync(path, "utf8"));
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error();
    for (const key of ["url", "api_key", "account", "account_id", "user", "user_id", "actor_peer_id", "peer_id"]) {
      if (file[key] !== undefined && typeof file[key] !== "string") throw new Error();
    }
    const baseUrl = text(file.url).replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (!/^https?:\/\//i.test(baseUrl) || !["http:", "https:"].includes(url.protocol)
      || !url.hostname || url.username || url.password || url.search || url.hash
      || !text(file.api_key)) throw new Error();
    const account = text(file.account) || text(file.account_id);
    const user = text(file.user) || text(file.user_id);
    const plugin = file.plugin || {};
    const scoped = plugin.codex || {};
    const explicitMode = scoped.authMode ?? scoped.auth_mode
      ?? plugin.authMode ?? plugin.auth_mode ?? file.authMode ?? file.auth_mode;
    const authMode = explicitMode === undefined
      ? ((account || user) ? "trusted" : "api_key") : text(explicitMode).toLowerCase();
    if (!["trusted", "api_key"].includes(authMode)) throw new Error();
    const recallPeerScope = scoped.recallPeerScope ?? plugin.recallPeerScope ?? "all";
    if (!["actor", "all"].includes(recallPeerScope)) throw new Error();
    return {
      ...primaryCfg, configPath: path, cliConfigPath: path, ovConfigPath: null,
      credentialSource: "ovcli", baseUrl, apiKey: text(file.api_key), account, user,
      peerId: text(file.actor_peer_id) || text(file.peer_id), authMode,
      sendIdentityHeaders: authMode === "trusted", mcpUrl: baseUrl + "/mcp",
      workspacePeer: false, recallPeerScope,
    };
  } catch {
    throw new Error("Invalid OpenViking read source: " + name);
  }
}

export function canonicalDirectory(path) {
  const absolute = resolve(path);
  let ancestor = absolute;
  while (true) {
    try { return resolve(realpathSync(ancestor), relative(ancestor, absolute)); }
    catch (error) {
      if (error.code !== "ENOENT" || dirname(ancestor) === ancestor) {
        throw new Error("Invalid OpenViking read routing directory");
      }
      ancestor = dirname(ancestor);
    }
  }
}

export function resolveReadMode(routing, cwd = process.cwd()) {
  if (!routing || typeof routing !== "object" || Array.isArray(routing)
    || !["separate", "combined"].includes(routing.mode)) {
    throw new Error("Invalid OpenViking read routing");
  }
  let mode = routing.mode;
  let matchedDirectory = null;
  if (routing.directories !== undefined) {
    if (!routing.directories || typeof routing.directories !== "object" || Array.isArray(routing.directories)) {
      throw new Error("Invalid OpenViking read routing directories");
    }
    const current = canonicalDirectory(cwd);
    let closest = "";
    for (const [directory, override] of Object.entries(routing.directories)) {
      const expanded = directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory;
      if (!isAbsolute(expanded) || !["separate", "combined"].includes(override)) {
        throw new Error("Invalid OpenViking read routing directory");
      }
      const path = canonicalDirectory(expanded);
      const child = relative(path, current);
      if ((child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(".." + sep)))
        && path.length > closest.length) {
        closest = path;
        mode = override;
        matchedDirectory = directory;
      }
    }
  }
  return { mode, matchedDirectory };
}

export function resolveReadRouting(primaryCfg, routing, cwd = process.cwd(),
  routingPath = join(homedir(), ".openviking", "read-routing.json")) {
  const separate = {
    mode: "separate", sources: [{ name: "current", config: primaryCfg, primary: true }],
    watchedPaths: [routingPath],
  };
  const { mode } = resolveReadMode(routing, cwd);
  if (mode === "separate") return separate;
  if (!routing.sources || typeof routing.sources !== "object" || Array.isArray(routing.sources)
    || Object.keys(routing.sources).length !== 2
    || !Object.hasOwn(routing.sources, "local") || !Object.hasOwn(routing.sources, "team")) {
    throw new Error("Combined OpenViking reads require local and team sources");
  }
  const watchedPaths = [routingPath];
  const sources = [];
  for (const name of ["local", "team"]) {
    let path = text(routing.sources[name]);
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (!path || !isAbsolute(path)) throw new Error("OpenViking read source path must be absolute: " + name);
    path = resolve(path);
    watchedPaths.push(path);
    let config = sourceConfig(name, path, primaryCfg);
    const primary = readIdentity(config) === readIdentity(primaryCfg);
    if (primary) config = { ...config, ...primaryCfg, mcpUrl: primaryCfg.mcpUrl || config.mcpUrl };
    else if (config.recallPeerScope === "actor" && !config.peerId) {
      throw new Error("Actor-scoped OpenViking read source requires its own peer: " + name);
    }
    const duplicate = sources.find((source) => readIdentity(source.config) === readIdentity(config));
    if (duplicate) {
      duplicate.names = [...(duplicate.names || [duplicate.name]), name];
      duplicate.primary ||= primary;
    } else sources.push({ name, config, primary });
  }
  if (!sources.some((source) => source.primary)) {
    throw new Error("Primary OpenViking identity does not match a read source");
  }
  return { mode: "combined", sources, watchedPaths: [...new Set(watchedPaths)] };
}

export function loadReadRouting(primaryCfg, cwd = process.cwd()) {
  const routingPath = join(homedir(), ".openviking", "read-routing.json");
  let routing;
  try { routing = JSON.parse(readFileSync(routingPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") routing = { mode: "separate" };
    else throw new Error("Invalid OpenViking read routing");
  }
  return resolveReadRouting(primaryCfg, routing, cwd, routingPath);
}

export async function requestReadJSON(source, path, init = {}, options = {}) {
  const cfg = source.config;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || cfg.timeoutMs || 15000);
  try {
    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) { headers.Authorization = "Bearer " + cfg.apiKey; headers["X-API-Key"] = cfg.apiKey; }
    if (cfg.sendIdentityHeaders && cfg.account) headers["X-OpenViking-Account"] = cfg.account;
    if (cfg.sendIdentityHeaders && cfg.user) headers["X-OpenViking-User"] = cfg.user;
    const peer = options.actorPeerId ?? cfg.peerId;
    if (peer) headers["X-OpenViking-Actor-Peer"] = peer;
    if (cfg.userAgent) headers["User-Agent"] = cfg.userAgent;
    const res = await fetch(cfg.baseUrl + path, { ...init, headers, signal: controller.signal, redirect: "error" });
    const body = await res.json().catch(() => null);
    if (!body) return { ok: false, status: res.status, result: null };
    if (!res.ok || body.status === "error") {
      return { ok: false, status: res.status, result: null, error: body.error || body };
    }
    return { ok: true, status: res.status, result: body.result ?? body };
  } catch {
    return { ok: false, status: 0, result: null,
      error: { message: controller.signal.aborted ? "OpenViking read timed out" : "OpenViking read failed" } };
  } finally { clearTimeout(timer); }
}

export function formatReadSource(name, content) {
  const label = String(name).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;",
  })[char]);
  return '<openviking-read-source name="' + label + '">\n'
    + "OpenViking source: " + label + '. Use MCP _ov_source="' + label + '" for follow-up reads.\n'
    + String(content) + "\n</openviking-read-source>";
}
