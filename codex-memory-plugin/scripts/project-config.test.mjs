// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEnvironment, resolveProjectConfig, resolveSharedConnection } from "./project-config.mjs";
import { resolveOpenVikingCredentials } from "./ov-credentials.mjs";
import { getStateDir, assertSessionRoute } from "./session-state.mjs";

test("project config overrides global, inherits in subdirectories, and stops at repository boundaries", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-project-"));
  const previousHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    const project = join(dir, "project");
    const child = join(project, "src", "nested");
    mkdirSync(child, { recursive: true });
    mkdirSync(join(project, ".git"));
    mkdirSync(join(project, ".openviking"));
    const path = join(project, ".openviking", "ovcli.conf");
    writeFileSync(path, JSON.stringify({ url: "https://team.example", api_key: "team-key" }));
    assert.throws(() => projectEnvironment({}, child), /Invalid project OpenViking config/);
    mkdirSync(join(dir, ".openviking"));
    writeFileSync(join(dir, ".openviking", "project-configs.json"), JSON.stringify({ [path]: "https://team.example" }));
    const env = projectEnvironment({}, child);
    assert.equal(env.OPENVIKING_CLI_CONFIG_FILE, path);
    assert.equal(env.OPENVIKING_CREDENTIAL_SOURCE, "cli");
    const creds = resolveOpenVikingCredentials(env);
    assert.equal(creds.baseUrl, "https://team.example");
    assert.equal(creds.apiKey, "team-key");
    const separate = join(child, "separate-repo");
    mkdirSync(join(separate, ".git"), { recursive: true });
    assert.deepEqual(projectEnvironment({}, separate), {});
    const explicit = { OPENVIKING_CLI_CONFIG_FILE: "/manual/ovcli.conf" };
    assert.equal(projectEnvironment(explicit, child), explicit);
    writeFileSync(path, "{");
    assert.throws(() => projectEnvironment({}, child), /Invalid project OpenViking config/);
    writeFileSync(path, JSON.stringify({ url: "https://team.example" }));
    assert.throws(() => projectEnvironment({}, child), /Invalid project OpenViking config/);
    writeFileSync(path, JSON.stringify({ url: "file:///tmp/wrong", api_key: "k" }));
    assert.throws(() => projectEnvironment({}, child), /Invalid project OpenViking config/);
    rmSync(path);
    assert.throws(() => projectEnvironment({}, child), /Invalid project OpenViking config/);
    writeFileSync(join(dir, ".openviking", "project-configs.json"), "{}");
    assert.deepEqual(projectEnvironment({}, child), {});
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("state directories separate connection identities and keep explicit state overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "ov-state-routing-"));
  const original = { ...process.env };
  try {
    delete process.env.OPENVIKING_CODEX_STATE_DIR;
    const path = join(dir, "ovcli.conf");
    process.env.OPENVIKING_CLI_CONFIG_FILE = path;
    process.env.OPENVIKING_CREDENTIAL_SOURCE = "cli";
    writeFileSync(path, JSON.stringify({ url: "https://local.example", api_key: "local-key" }));
    const local = getStateDir();
    process.env.OPENVIKING_CODEX_STATE_DIR = dir;
    assertSessionRoute("same-session");
    delete process.env.OPENVIKING_CODEX_STATE_DIR;
    writeFileSync(path, JSON.stringify({ url: "https://team.example", api_key: "team-key" }));
    const team = getStateDir();
    process.env.OPENVIKING_CODEX_STATE_DIR = dir;
    assert.throws(() => assertSessionRoute("same-session"), /connection changed/);
    delete process.env.OPENVIKING_CODEX_STATE_DIR;
    assert.notEqual(local, team);
    assert.ok(!team.includes("team-key"));
    writeFileSync(path, JSON.stringify({ url: "https://team.example", api_key: "another-user-key" }));
    assert.notEqual(getStateDir(), team);
    process.env.OPENVIKING_CODEX_STATE_DIR = dir;
    assert.equal(getStateDir(), dir);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared connections validate approved URLs and return the exact credential snapshot", () => {
  const cwd = join(tmpdir(), "shared-project");
  const path = join(tmpdir(), "shared-team.conf");
  const file = { url: "HTTPS://TEAM.EXAMPLE:443/", api_key: "synthetic-team-key" };
  const routing = { mode: "separate", writeDirectories: { [cwd]: "team" },
    sources: { team: path }, sourceUrls: { team: "https://team.example" } };
  const connection = resolveSharedConnection(routing, cwd, (requested) => { assert.equal(requested, path); return file; });
  assert.equal(connection.cliFile, file);
  assert.equal(connection.path, path);
  assert.equal(connection.source, "team");
  assert.equal(resolveSharedConnection(routing, cwd + "-other"), null);
  assert.deepEqual(resolveSharedConnection({ writeDirectories: { [cwd]: "default" } }, cwd),
    { source: "default", matchedDirectory: cwd });
  for (const changes of [
    { sources: { team: "relative.conf" } }, { sources: {} }, { sourceUrls: {} },
    { sourceUrls: { team: "https://unapproved.example" } },
  ]) assert.throws(() => resolveSharedConnection({ ...routing, ...changes }, cwd, () => file), /Invalid shared/);
  for (const invalid of [null, [], {}, { ...file, api_key: "" }, { ...file, account: 123 },
    { ...file, url: "https://user:secret@team.example" }, { ...file, url: "https://team.example?token=secret" },
    { ...file, plugin: [] }, { ...file, plugin: { codex: { authMode: "typo" } } }]) {
    assert.throws(() => resolveSharedConnection(routing, cwd, () => invalid), /Invalid shared/);
  }
  assert.throws(() => resolveSharedConnection(routing, cwd, () => { throw new Error("synthetic-secret"); }),
    (error) => /Invalid shared/.test(error.message) && !error.message.includes("synthetic-secret"));
});

test("shared project mappings follow legacy approval precedence and revalidate their original directory", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ov-shared-project-"));
  const originalHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, "project"), nested = join(project, "src");
  const team = join(root, ".openviking", "team.conf"), local = join(root, ".openviking", "ovcli.conf");
  const routingPath = join(root, ".openviking", "read-routing.json");
  const registry = join(root, ".openviking", "project-configs.json");
  const legacy = join(project, ".openviking", "ovcli.conf");
  mkdirSync(join(root, ".openviking"));
  mkdirSync(join(project, ".git"), { recursive: true });
  mkdirSync(join(project, ".openviking"));
  mkdirSync(nested);
  writeFileSync(local, JSON.stringify({ url: "https://local.example", api_key: "synthetic-local-key" }));
  writeFileSync(team, JSON.stringify({ url: "https://team.example", api_key: "synthetic-team-key" }));
  const routing = { mode: "separate", writeDirectories: { [project]: "team" },
    sources: { team: "~/.openviking/team.conf" }, sourceUrls: { team: "https://team.example" } };
  const save = (value) => writeFileSync(routingPath, JSON.stringify(value));
  save(routing);
  const env = projectEnvironment({}, nested);
  assert.equal(env.OPENVIKING_CLI_CONFIG_FILE, team);
  assert.equal(resolveProjectConfig(env, root).cliFile.api_key, "synthetic-team-key");
  const explicit = { OPENVIKING_CLI_CONFIG_FILE: "/explicit.conf" };
  assert.equal(projectEnvironment(explicit, nested), explicit);
  for (const changed of [
    { ...routing, writeDirectories: {} }, { ...routing, writeDirectories: { [project]: "default" } },
    { ...routing, sources: { team: local }, sourceUrls: { team: "https://local.example" } },
  ]) {
    save(changed);
    assert.throws(() => resolveProjectConfig(env, root), /Invalid shared/);
  }
  save({ ...routing, writeDirectories: { [root]: "team", [project]: "default" } });
  const defaultEnv = projectEnvironment({}, nested);
  assert.equal(defaultEnv.OPENVIKING_CLI_CONFIG_FILE, undefined);
  save({ ...routing, writeDirectories: {} });
  assert.throws(() => resolveProjectConfig(defaultEnv), /Invalid shared/);
  save(routing);
  writeFileSync(legacy, JSON.stringify({ url: "https://legacy.example", api_key: "synthetic-legacy-key" }));
  assert.throws(() => projectEnvironment({}, nested), /Invalid project/);
  writeFileSync(registry, JSON.stringify({ [legacy]: "https://legacy.example" }));
  assert.equal(projectEnvironment({}, nested).OPENVIKING_CLI_CONFIG_FILE, legacy);
  assert.throws(() => resolveProjectConfig(env), /Invalid shared/);
});
