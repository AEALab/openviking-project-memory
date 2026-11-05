import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "./config.mjs";
import { loadCredentialFiles, resolveOpenVikingCredentials } from "./ov-credentials.mjs";
import { projectEnvironment } from "./project-config.mjs";

function fixture(t) {
  const originalEnv = { ...process.env };
  const originalCwd = process.cwd();
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ov-credential-snapshot-")));
  const project = join(root, "project");
  const path = join(project, ".openviking", "ovcli.conf");
  const registry = join(root, ".openviking", "project-configs.json");
  fs.mkdirSync(join(root, ".openviking"));
  fs.mkdirSync(join(project, ".git"), { recursive: true });
  fs.mkdirSync(join(project, ".openviking"));
  const original = {
    url: "https://approved.example", api_key: "approved-key",
    account: "approved-account", user: "approved-user", actor_peer_id: "approved-peer",
    plugin: { recallLimit: 11, codex: { recallLimit: 12, autoCapture: false } },
  };
  fs.writeFileSync(path, JSON.stringify(original));
  fs.writeFileSync(registry, JSON.stringify({ [path]: original.url }));
  for (const key of Object.keys(process.env)) if (key.startsWith("OPENVIKING_")) delete process.env[key];
  process.env.HOME = root;
  process.env.OPENVIKING_CONFIG_FILE = join(root, "absent-ov.conf");
  process.chdir(project);
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { path, registry, original };
}

function changeAfterRead(t, path, change) {
  let reads = 0;
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", function (file, ...args) {
    const value = readFileSync.call(this, file, ...args);
    if (file === path && ++reads === 1) change();
    return value;
  });
  syncBuiltinESMExports();
  return () => reads;
}

for (const change of ["replaced", "corrupted", "removed"]) {
  test(`project credentials retain the validated snapshot if the file is ${change} after reading`, (t) => {
    const f = fixture(t);
    const reads = changeAfterRead(t, f.path, () => {
      if (change === "removed") fs.rmSync(f.path);
      else fs.writeFileSync(f.path, change === "corrupted" ? "{" : JSON.stringify({ url: "https://other.example", api_key: "other-key" }));
    });
    const creds = resolveOpenVikingCredentials();
    assert.equal(creds.baseUrl, f.original.url);
    assert.equal(creds.apiKey, f.original.api_key);
    assert.equal(creds.account, f.original.account);
    assert.equal(creds.user, f.original.user);
    assert.equal(creds.peerId, f.original.actor_peer_id);
    assert.equal(creds.cliPath, f.path);
    assert.equal(reads(), 1);
    assert.throws(() => resolveOpenVikingCredentials(), /Invalid project OpenViking config/);
  });
}

test("loadConfig uses one validated snapshot for credentials and plugin settings", (t) => {
  const f = fixture(t);
  const reads = changeAfterRead(t, f.path, () => {
    fs.writeFileSync(f.path, JSON.stringify({ ...f.original, api_key: "rotated-key", plugin: { codex: { recallLimit: 99, autoCapture: true } } }));
  });
  const config = loadConfig();
  assert.equal(config.baseUrl, f.original.url);
  assert.equal(config.apiKey, f.original.api_key);
  assert.equal(config.recallLimit, 12);
  assert.equal(config.autoCapture, false);
  assert.equal(config.cliConfigPath, f.path);
  assert.equal(reads(), 1);
  const nextConfig = loadConfig();
  assert.equal(nextConfig.apiKey, "rotated-key");
  assert.equal(nextConfig.recallLimit, 99);
  assert.equal(nextConfig.autoCapture, true);
  assert.equal(reads(), 2);
});

test("the same file selected by both config variables is read once", (t) => {
  const f = fixture(t);
  process.env.OPENVIKING_CONFIG_FILE = f.path;
  fs.writeFileSync(f.path, JSON.stringify({ ...f.original, codex: { minQueryLength: 7 } }));
  const reads = changeAfterRead(t, f.path, () => {
    fs.writeFileSync(f.path, JSON.stringify({ ...f.original, codex: { minQueryLength: 99 } }));
  });
  const config = loadConfig();
  assert.equal(config.minQueryLength, 7);
  assert.equal(config.recallLimit, 12);
  assert.equal(reads(), 1);
});

test("projectEnvironment results are revalidated instead of becoming explicit overrides", (t) => {
  const f = fixture(t);
  const env = projectEnvironment({});
  const changed = { ...f.original, url: "https://other.example", api_key: "other-key" };
  fs.writeFileSync(f.path, JSON.stringify(changed));
  assert.throws(() => resolveOpenVikingCredentials(env), /Invalid project OpenViking config/);
  assert.throws(() => loadCredentialFiles(env), /Invalid project OpenViking config/);
  fs.writeFileSync(f.registry, JSON.stringify({ [f.path]: changed.url }));
  assert.equal(resolveOpenVikingCredentials(env).apiKey, "other-key");
  fs.rmSync(f.path);
  assert.throws(() => resolveOpenVikingCredentials(env), /Invalid project OpenViking config/);
});

test("explicit and legacy CLI config overrides preserve credentials and tuning", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.registry, "{}");
  process.env.OPENVIKING_CLI_CONFIG_FILE = f.path;
  process.env.OPENVIKING_API_KEY = "env-key";
  assert.equal(loadConfig().apiKey, "env-key");
  assert.equal(loadConfig().recallLimit, 12);
  process.env.OPENVIKING_CREDENTIAL_SOURCE = "cli";
  assert.equal(loadConfig().apiKey, f.original.api_key);
  fs.rmSync(f.path);
  fs.writeFileSync(f.registry, "{}");
  const legacy = join(process.cwd(), "legacy.conf");
  fs.writeFileSync(legacy, JSON.stringify(f.original));
  delete process.env.OPENVIKING_CLI_CONFIG_FILE;
  process.env.OPENVIKING_CONFIG_FILE = legacy;
  const config = loadConfig();
  assert.equal(config.apiKey, f.original.api_key);
  assert.equal(config.cliConfigPath, legacy);
  assert.equal(config.ovConfigPath, "");
  assert.equal(config.recallLimit, 12);
});
