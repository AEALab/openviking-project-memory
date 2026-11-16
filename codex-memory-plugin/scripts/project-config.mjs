// Community modification (2026-11-05): project routing and configurable multi-library reads.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { normalizeConnectionUrl, resolveWriteSource, sourceConfig } from "./read-routing.mjs";

// Track provenance only; each resolution rereads and validates the original project's route.
const projectRoutes = new WeakMap();

export function resolveSharedConnection(routing, cwd = process.cwd(),
  readFile = (path) => JSON.parse(readFileSync(path, "utf8"))) {
  const selection = resolveWriteSource(routing, cwd);
  const { source } = selection;
  if (source === null) return null;
  if (source === "default") return selection;
  try {
    let path = routing.sources?.[source];
    if (typeof path !== "string") throw new Error();
    path = path.trim();
    if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
    if (!isAbsolute(path)) throw new Error();
    path = resolve(path);
    const cliFile = readFile(path);
    if (!cliFile || typeof cliFile !== "object" || Array.isArray(cliFile)) throw new Error();
    const config = sourceConfig(source, path, {}, cliFile);
    const approvedUrl = routing.sourceUrls?.[source];
    if (typeof approvedUrl !== "string" || !approvedUrl.trim()
      || normalizeConnectionUrl(approvedUrl).replace(/\/+$/, "")
        !== normalizeConnectionUrl(config.baseUrl).replace(/\/+$/, "")) throw new Error();
    return { ...selection, path, cliFile };
  } catch {
    throw new Error("Invalid shared OpenViking connection: " + source);
  }
}

function routedConfig(env, cwd, route, cliFile) {
  const routedEnv = route.path
    ? { ...env, OPENVIKING_CLI_CONFIG_FILE: route.path, OPENVIKING_CREDENTIAL_SOURCE: "cli" }
    : { ...env };
  projectRoutes.set(routedEnv, { ...route, env, cwd });
  return cliFile === undefined ? { env: routedEnv } : { env: routedEnv, cliFile };
}

// Explicit launch overrides remain available; otherwise use the nearest project file.
export function resolveProjectConfig(env = process.env, cwd = process.cwd()) {
  const previous = projectRoutes.get(env);
  if (previous) {
    const result = resolveProjectConfig(previous.env, previous.cwd);
    const current = projectRoutes.get(result.env);
    if (!current || ["kind", "path", "source"].some((key) => current[key] !== previous[key])) {
      throw new Error(previous.kind === "project"
        ? `Invalid project OpenViking config: ${previous.path}` : "Invalid shared OpenViking connection: route changed");
    }
    return result;
  }
  if (env.OPENVIKING_CLI_CONFIG_FILE?.trim()) return { env };
  let approved;
  try { approved = JSON.parse(readFileSync(join(homedir(), ".openviking", "project-configs.json"), "utf8")); }
  catch (err) { if (err.code === "ENOENT") approved = {}; else throw new Error("Invalid OpenViking project registry"); }
  if (!approved || typeof approved !== "object" || Array.isArray(approved)) {
    throw new Error("Invalid OpenViking project registry");
  }
  const projectDirectory = resolve(cwd);
  let dir = projectDirectory;
  while (true) {
    if (dir === homedir()) break;
    const path = join(dir, ".openviking", "ovcli.conf");
    let raw;
    try { raw = readFileSync(path, "utf8"); }
    catch (err) {
      if (!["ENOENT", "ENOTDIR"].includes(err.code)) throw err;
      if (approved[path]) throw new Error(`Invalid project OpenViking config: ${path}`);
    }
    if (raw !== undefined) {
      let file;
      try {
        file = JSON.parse(raw);
        const url = new URL(file.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
          || typeof file.api_key !== "string" || !file.api_key.trim()) throw new Error();
        if (!approved[path] || new URL(approved[path]).href !== url.href) throw new Error();
      } catch {
        // Fail closed: a broken team config must never send its conversation to the default server.
        throw new Error(`Invalid project OpenViking config: ${path}`);
      }
      return routedConfig(env, projectDirectory, { kind: "project", path }, file);
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || parent === dir) break;
    dir = parent;
  }
  let routing;
  try { routing = JSON.parse(readFileSync(join(homedir(), ".openviking", "read-routing.json"), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { env };
    throw new Error("Invalid OpenViking read routing");
  }
  const shared = resolveSharedConnection(routing, projectDirectory);
  if (!shared) return { env };
  return routedConfig(env, projectDirectory, { kind: "shared", source: shared.source, path: shared.path }, shared.cliFile);
}

export function projectEnvironment(env = process.env, cwd = process.cwd()) {
  return resolveProjectConfig(env, cwd).env;
}
