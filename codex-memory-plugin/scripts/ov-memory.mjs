#!/usr/bin/env node
// Community modification (2026-11-05): shared read-mode command and directory validation.

import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.mjs";
import { canonicalDirectory, resolveReadMode, resolveReadRouting } from "./read-routing.mjs";

const USAGE = "Usage: ov-memory [status]\n       ov-memory read separate|combined|inherit\n       ov-memory read separate|combined --global";
class CommandError extends Error {}

function parseArgs(args) {
  if (!args.length || (args.length === 1 && args[0] === "status")) return { command: "status" };
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "help" };
  if (args[0] !== "read" || !["separate", "combined", "inherit"].includes(args[1])
    || !(args.length === 2 || (args.length === 3 && args[2] === "--global"))) throw new CommandError(USAGE);
  if (args[1] === "inherit" && args[2] === "--global") {
    throw new CommandError("Global mode must be separate or combined; inherit only removes the current directory rule.");
  }
  return { command: "read", mode: args[1], global: args[2] === "--global" };
}

function readRouting(path) {
  let bytes;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new CommandError("Refusing symlink read-routing.json; use a regular configuration file.");
    bytes = readFileSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return { routing: { mode: "separate" }, bytes: null };
    if (error instanceof CommandError) throw error;
    throw new CommandError("Unable to read OpenViking read routing; check file permissions.");
  }
  let routing;
  try { routing = JSON.parse(bytes.toString("utf8")); }
  catch { throw new CommandError("Invalid OpenViking read routing JSON."); }
  return { routing, bytes };
}

function modeFor(routing, cwd) {
  try { return resolveReadMode(routing, cwd); }
  catch { throw new CommandError("Invalid OpenViking read routing mode or directories."); }
}

function planFor(cfg, routing, cwd, path) {
  try { return resolveReadRouting(cfg, routing, cwd, path); }
  catch {
    throw new CommandError("Invalid OpenViking read plan; combined mode requires valid local and team sources matching the active identity.");
  }
}

function updateRouting(routing, options, cwd) {
  if (options.global) return { ...routing, mode: options.mode };
  const directories = { ...routing.directories };
  for (const directory of Object.keys(directories)) {
    const expanded = directory.startsWith("~/") ? join(homedir(), directory.slice(2)) : directory;
    if (canonicalDirectory(expanded) === cwd && (options.mode === "inherit" || directory !== cwd)) delete directories[directory];
  }
  if (options.mode !== "inherit") directories[cwd] = options.mode;
  if (!routing.directories && !Object.keys(directories).length) return routing;
  return { ...routing, directories };
}

function writeRouting(path, bytes, routing) {
  const suffix = Date.now() + "-" + randomUUID();
  const temporary = path + ".tmp-" + suffix;
  const backup = path + ".backup-" + suffix;
  let backedUp = false;
  let locked = false;
  const lock = path + ".lock";
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code === "EEXIST") throw new CommandError("OpenViking read routing is locked by another command; retry when it finishes.");
      throw error;
    }
    locked = true;
    let current = null;
    try {
      if (lstatSync(path).isSymbolicLink()) throw new CommandError("Refusing symlink read-routing.json; use a regular configuration file.");
      current = readFileSync(path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if ((bytes === null) !== (current === null) || (bytes !== null && !bytes.equals(current))) {
      throw new CommandError("OpenViking read routing changed during this command; retry.");
    }
    writeFileSync(temporary, JSON.stringify(routing, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    if (bytes !== null) { writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 }); backedUp = true; }
    renameSync(temporary, path);
    return backedUp ? backup : null;
  } catch (error) {
    rmSync(temporary, { force: true });
    if (backedUp) rmSync(backup, { force: true });
    if (error instanceof CommandError) throw error;
    throw new CommandError("Unable to save OpenViking read routing; the original configuration was preserved.");
  } finally {
    // shortcut: a killed writer may leave its lock; remove it only after confirming no writer is running.
    if (locked) rmSync(lock, { force: true });
  }
}

function statusText(cfg, routing, mode, plan, cwd, path, missing) {
  let url;
  try {
    const parsed = new URL(cfg.baseUrl);
    parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = "";
    url = parsed.toString();
  } catch { url = "(invalid URL)"; }
  const origin = cfg.credentialSource === "env" ? "environment" : (cfg.configPath || "built-in defaults");
  const output = [
    "Current directory: " + cwd,
    "Read routing configuration: " + path + (missing ? " (missing; default separate)" : " (configured)"),
    "Global read mode: " + routing.mode,
    "Closest directory rule: " + (mode.matchedDirectory || "none (global default)"),
    "Effective configured read mode: " + mode.mode,
    "Read sources: " + plan.sources.map((source) => source.name).join(", "),
    "Write URL: " + url,
    "Write configuration origin: " + origin + " (" + cfg.credentialSource + ")",
    "Current live MCP read mode: unknown (configuration is not live-session state).",
    "Start a new Codex session or restart Codex to apply the configured mode to MCP.",
  ].join("\n");
  return cfg.apiKey ? output.replaceAll(cfg.apiKey, "[redacted]") : output;
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.command === "help") { console.log(USAGE); return; }
    const cwd = canonicalDirectory(process.cwd());
    const path = join(homedir(), ".openviking", "read-routing.json");
    const loaded = readRouting(path);
    modeFor(loaded.routing, cwd);
    let cfg;
    try { cfg = loadConfig(); }
    catch { throw new CommandError("Invalid active OpenViking configuration; check the selected configuration file."); }
    const routing = options.command === "read" ? updateRouting(loaded.routing, options, cwd) : loaded.routing;
    const mode = modeFor(routing, cwd);
    if (options.global) planFor(cfg, { ...routing, directories: {} }, cwd, path);
    const plan = planFor(cfg, routing, cwd, path);
    const output = statusText(cfg, routing, mode, plan, cwd, path, loaded.bytes === null);
    if (options.command === "read") {
      const changed = JSON.stringify(routing) !== JSON.stringify(loaded.routing);
      const backup = changed ? writeRouting(path, loaded.bytes, routing) : null;
      console.log(changed ? "Saved OpenViking read routing." : "OpenViking read routing is unchanged.");
      if (backup) console.log("Backup: " + backup);
    }
    console.log(output);
  } catch (error) {
    console.error("ov-memory: " + (error instanceof CommandError ? error.message : "Unable to read or update OpenViking configuration."));
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
