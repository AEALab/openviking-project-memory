#!/usr/bin/env node
// Community addition: npm registration without changing connection credentials.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "smol-toml";
import { resolveCodexLaunch } from "../codex-memory-plugin/scripts/codex-launch.mjs";
import { mergeCodexConfig } from "./codex-config.mjs";
import { setupAfterInstall } from "./setup-after-install.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "openviking-memory@openviking-project";

function readConfig(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Codex config.toml must be a regular file; resolve its symlink before installing.");
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function parseConfig(text) {
  try { return parse(text); }
  catch { throw new Error("Invalid Codex config.toml; fix it before installing. Its contents were not printed."); }
}

function saveConfig(path, expected, text) {
  if (readConfig(path) !== expected) throw new Error("Codex config.toml changed during installation; retry without editing it at the same time.");
  if (text === expected) return;
  const temporary = path + ".openviking-project-memory.tmp-" + randomUUID();
  try {
    writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export function install({
  env = process.env,
  home = homedir(),
  packageRoot = PACKAGE_ROOT,
  run = spawnSync,
  log = console.log,
} = {}) {
  const codexHome = resolve(env.CODEX_HOME || join(home, ".codex"));
  const configPath = join(codexHome, "config.toml");
  const stateHome = join(home, ".openviking");
  const options = { packageRoot, nodePath: process.execPath, stateHome };
  const launch = resolveCodexLaunch({ pathValue: env.PATH, execPath: process.execPath });
  const command = (args) => {
    const result = run(launch.command, [...launch.argsPrefix, ...args], {
      env: { ...env, CODEX_HOME: codexHome }, cwd: codexHome,
      encoding: "utf8", timeout: 30_000, stdio: "pipe",
    });
    if (result.error || result.status !== 0) {
      // Codex errors may contain user config values; do not echo captured output.
      throw new Error(`codex ${args.slice(0, 3).join(" ")} failed. Check that a compatible Codex CLI is on PATH, then run openviking-project-memory install again.`);
    }
  };

  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const lock = join(codexHome, ".openviking-project-memory-install.lock");
  try { writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("Another OpenViking Project Memory install is running. If it was interrupted, confirm the PID in " + lock + " has exited before removing the lock.");
    throw error;
  }
  let backup;
  let previousConfig;
  let registrationStarted = false;
  let committed = false;
  try {
    const original = readConfig(configPath);
    previousConfig = parseConfig(original);
    mergeCodexConfig(previousConfig, options); // Validate before Codex can change configuration.
    command(["--version"]);
    if (original) {
      backup = configPath + ".openviking-project-memory.backup-" + Date.now() + "-" + randomUUID();
      writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
    }
    registrationStarted = true;
    const marketplace = previousConfig.marketplaces?.["openviking-project"];
    if (marketplace && (marketplace.source_type !== "local" || resolve(marketplace.source) !== resolve(packageRoot))) {
      command(["plugin", "marketplace", "remove", "openviking-project"]);
    }
    command(["plugin", "marketplace", "add", packageRoot, "--json"]);
    command(["plugin", "add", PLUGIN_ID, "--json"]);
    const current = readConfig(configPath);
    const config = mergeCodexConfig(parseConfig(current), { ...options, previousConfig });
    const next = stringify(config);
    saveConfig(configPath, current, next);
    committed = true;
    const enabled = config.plugins[PLUGIN_ID].enabled && config.mcp_servers["openviking-memory"].enabled;
    log("OpenViking Project Memory registered. Global plugin and MCP: " + (enabled ? "enabled" : "existing disabled settings preserved") + ".");
    if (backup) log("Previous Codex configuration: " + backup);
    log("Server connection: run openviking-project-memory setup if not configured. Restart Codex and open a new chat to apply.");
    return { configPath, backup };
  } catch (error) {
    // plugin add may enable the plugin before failing; restore only our flag, retaining unrelated edits.
    if (registrationStarted && !committed) {
      try {
        const current = readConfig(configPath);
        const config = parseConfig(current);
        if (config.plugins?.[PLUGIN_ID]) {
          const previous = previousConfig.plugins?.[PLUGIN_ID];
          if (!previous) delete config.plugins[PLUGIN_ID];
          else if (Object.hasOwn(previous, "enabled")) config.plugins[PLUGIN_ID].enabled = previous.enabled;
          else delete config.plugins[PLUGIN_ID].enabled;
          saveConfig(configPath, current, stringify(config));
        }
      } catch {
        error.message += " Could not restore the original plugin enabled setting; check it before retrying.";
      }
    }
    if (backup) error.message += " Previous configuration is saved at " + backup + "; registration may be incomplete.";
    throw error;
  } finally { rmSync(lock, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const postinstall = process.argv[2] === "--postinstall";
  if (postinstall && process.env.npm_config_global !== "true") {
    console.log("OpenViking Project Memory: local install does not change Codex. Run openviking-project-memory install to register manually.");
  } else {
    try { install(); await setupAfterInstall(); }
    catch (error) {
      console.error("OpenViking Project Memory: " + error.message);
      if (postinstall) console.error("Automatic Codex registration failed. Fix the cause, then rerun npm install -g @haowux/openviking-project-memory.");
      process.exitCode = 1;
    }
  }
}
