// Community modification (2026-11-05): project routing and configurable multi-library reads.
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// Track provenance only; each resolution rereads and validates the project file.
const projectPaths = new WeakMap();

// Explicit launch overrides remain available; otherwise use the nearest project file.
export function resolveProjectConfig(env = process.env, cwd = process.cwd()) {
  const projectPath = projectPaths.get(env);
  if (!projectPath && env.OPENVIKING_CLI_CONFIG_FILE?.trim()) return { env };
  let approved;
  try { approved = JSON.parse(readFileSync(join(homedir(), ".openviking", "project-configs.json"), "utf8")); }
  catch (err) { if (err.code === "ENOENT") approved = {}; else throw new Error("Invalid OpenViking project registry"); }
  if (!approved || typeof approved !== "object" || Array.isArray(approved)) {
    throw new Error("Invalid OpenViking project registry");
  }
  let dir = projectPath ? dirname(dirname(projectPath)) : resolve(cwd);
  while (true) {
    if (dir === homedir()) return { env };
    const path = join(dir, ".openviking", "ovcli.conf");
    let raw;
    try { raw = readFileSync(path, "utf8"); }
    catch (err) {
      if (!["ENOENT", "ENOTDIR"].includes(err.code)) throw err;
      if (approved[path] || projectPath === path) throw new Error(`Invalid project OpenViking config: ${path}`);
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
      const routedEnv = { ...env, OPENVIKING_CLI_CONFIG_FILE: path, OPENVIKING_CREDENTIAL_SOURCE: "cli" };
      projectPaths.set(routedEnv, path);
      return { env: routedEnv, cliFile: file };
    }
    const parent = dirname(dir);
    if (existsSync(join(dir, ".git")) || dir === homedir() || parent === dir) return { env };
    dir = parent;
  }
}

export function projectEnvironment(env = process.env, cwd = process.cwd()) {
  return resolveProjectConfig(env, cwd).env;
}
