import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse, stringify } from "smol-toml";
import { install } from "./install.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = "openviking-memory@openviking-project";

function fixture(t, config) {
  const home = mkdtempSync(join(tmpdir(), "openviking-project-memory-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const codexHome = join(home, "custom codex home");
  mkdirSync(codexHome);
  const configPath = join(codexHome, "config.toml");
  if (config !== undefined) writeFileSync(configPath, config);
  const calls = [];
  const logs = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "plugin") {
      const current = parse(existsSync(configPath) ? readFileSync(configPath, "utf8") : "");
      if (args[1] === "marketplace" && args[2] === "add") {
        current.marketplaces = { "openviking-project": { source_type: "local", source: args[3] } };
      } else if (args[1] === "add") {
        current.plugins = { ...current.plugins, [PLUGIN]: { ...current.plugins?.[PLUGIN], enabled: true } };
      }
      writeFileSync(configPath, stringify(current));
    }
    return { status: 0 };
  };
  const options = {
    home, env: { ...process.env, CODEX_HOME: codexHome },
    packageRoot: join(home, "npm package with spaces"), run, log: (line) => logs.push(line),
  };
  return { home, codexHome, configPath, options, calls, logs };
}

test("registers once per install, preserves user settings and private backups, and reinstalls idempotently", (t) => {
  const original = '# user comment\nmodel = "existing-model"\n[mcp_servers.other]\ncommand = "other-tool"\n';
  const f = fixture(t, original);
  const first = install(f.options);
  assert.equal(readFileSync(first.backup, "utf8"), original);
  if (process.platform !== "win32") assert.equal(statSync(first.backup).mode & 0o777, 0o600);
  assert.deepEqual(f.calls.map((call) => call.args), [
    ["--version"], ["plugin", "marketplace", "add", f.options.packageRoot, "--json"],
    ["plugin", "add", PLUGIN, "--json"],
  ]);
  for (const call of f.calls) {
    assert.equal(call.options.env.CODEX_HOME, f.codexHome);
    assert.equal(call.options.cwd, f.codexHome);
    assert.equal(call.options.shell, undefined);
  }
  const saved = readFileSync(f.configPath, "utf8");
  const config = parse(saved);
  assert.equal(config.model, "existing-model");
  assert.equal(config.mcp_servers.other.command, "other-tool");
  assert.equal(config.plugins[PLUGIN].enabled, false);
  assert.equal(config.mcp_servers["openviking-memory"].args[0], join(f.options.packageRoot, "codex-memory-plugin/servers/mcp-proxy.mjs"));
  assert.equal(config.plugins[PLUGIN].mcp_servers["openviking-memory"].enabled, false);
  install(f.options);
  assert.equal(readFileSync(f.configPath, "utf8"), saved);
  assert.equal(existsSync(join(f.home, ".openviking")), false, "installer must not create or change credentials");
  assert.equal(existsSync(join(f.codexHome, ".openviking-project-memory-install.lock")), false);
});

test("reinstall migrates old marketplace paths and restores globally disabled plugin and MCP", (t) => {
  const f = fixture(t, stringify({
    marketplaces: { "openviking-project": { source_type: "local", source: "/old/source" } },
    plugins: { [PLUGIN]: { enabled: false } },
    mcp_servers: { "openviking-memory": { enabled: false } },
  }));
  install(f.options);
  assert.deepEqual(f.calls[1].args, ["plugin", "marketplace", "remove", "openviking-project"]);
  const config = parse(readFileSync(f.configPath, "utf8"));
  assert.equal(config.plugins[PLUGIN].enabled, false);
  assert.equal(config.mcp_servers["openviking-memory"].enabled, false);
});

test("invalid TOML and incompatible tables stop before any Codex command without revealing values", (t) => {
  for (const text of ['secret = "private-value"\n[broken', 'plugins = "private-value"']) {
    const f = fixture(t, text);
    assert.throws(() => install(f.options), (error) => !error.message.includes("private-value"));
    assert.equal(f.calls.length, 0);
    assert.equal(readFileSync(f.configPath, "utf8"), text);
  }
});

test("missing Codex leaves configuration untouched and releases the install lock", (t) => {
  const f = fixture(t, 'model = "existing"\n');
  assert.throws(() => install({ ...f.options, run: () => ({ error: new Error("ENOENT") }) }), /compatible Codex CLI/);
  assert.equal(readFileSync(f.configPath, "utf8"), 'model = "existing"\n');
  assert.deepEqual(readdirSync(f.codexHome), ["config.toml"]);
});

test("registration failure reports incomplete state and preserves an exact backup without exposing stderr", (t) => {
  const original = 'model = "existing"\n';
  const f = fixture(t, original);
  const run = (command, args, options) => args[0] === "plugin"
    ? { status: 1, stderr: "private-value" } : f.options.run(command, args, options);
  assert.throws(() => install({ ...f.options, run }), (error) => {
    assert.match(error.message, /registration may be incomplete/);
    assert.ok(!error.message.includes("private-value"));
    return true;
  });
  const backup = readdirSync(f.codexHome).find((name) => name.includes(".backup-"));
  assert.equal(readFileSync(join(f.codexHome, backup), "utf8"), original);
});

test("failure after Codex enables a plugin restores the original flag and retains unrelated edits before retry", (t) => {
  for (const existed of [true, false]) {
    const f = fixture(t, stringify(existed ? { plugins: { [PLUGIN]: { enabled: false } } } : {}));
    const run = (command, args, options) => {
      const result = f.options.run(command, args, options);
      if (args[0] === "plugin" && args[1] === "add") {
        const config = parse(readFileSync(f.configPath, "utf8"));
        config.model = "concurrent-user-edit";
        writeFileSync(f.configPath, stringify(config));
        return { status: 1 };
      }
      return result;
    };
    assert.throws(() => install({ ...f.options, run }), /failed/);
    const restored = parse(readFileSync(f.configPath, "utf8"));
    assert.equal(restored.model, "concurrent-user-edit");
    assert.equal(restored.plugins?.[PLUGIN]?.enabled, existed ? false : undefined);
    install(f.options);
    const retried = parse(readFileSync(f.configPath, "utf8"));
    assert.equal(retried.plugins[PLUGIN].enabled, false);
  }
});

test("a concurrent installer and a symlinked configuration are not overwritten", (t) => {
  const f = fixture(t, 'model = "existing"\n');
  const lock = join(f.codexHome, ".openviking-project-memory-install.lock");
  writeFileSync(lock, "12345");
  assert.throws(() => install(f.options), /Another OpenViking Project Memory install/);
  assert.equal(readFileSync(lock, "utf8"), "12345");
  rmSync(lock);
  const actual = join(f.home, "actual.toml");
  writeFileSync(actual, 'model = "keep"\n');
  rmSync(f.configPath);
  symlinkSync(actual, f.configPath);
  assert.throws(() => install(f.options), /regular file/);
  assert.equal(readFileSync(actual, "utf8"), 'model = "keep"\n');
});

test("a local npm lifecycle install does not configure Codex", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/install.mjs"), "--postinstall"], {
    env: { ...f.options.env, npm_config_global: "false" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /local install does not change Codex/);
  assert.equal(existsSync(f.configPath), false);
});

test("a failed global npm registration fails visibly and explains how to retry", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/install.mjs"), "--postinstall"], {
    env: { ...f.options.env, PATH: join(f.home, "no executables"), npm_config_global: "true" }, encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Automatic Codex registration failed/);
  assert.match(result.stderr, /npm install -g @haowux\/openviking-project-memory/);
  assert.equal(existsSync(f.configPath), false);
});
