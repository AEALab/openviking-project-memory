// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectEnvironment } from "./project-config.mjs";
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
