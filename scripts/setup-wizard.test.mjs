import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";
import { runSetupWizard } from "./setup-wizard.mjs";
import { resolveReadRouting, sourceConfig } from "../codex-memory-plugin/scripts/read-routing.mjs";
import { projectEnvironment, resolveProjectConfig } from "../codex-memory-plugin/scripts/project-config.mjs";

const PLUGIN = "openviking-memory@openviking-project";
function fixture(t) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "ov-full-setup-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = join(home, ".openviking");
  const project = join(home, "project");
  mkdirSync(project);
  const write = (path, value) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value)); };
  let output = "";
  return {
    home, state, project, write,
    json: (path) => JSON.parse(readFileSync(path, "utf8")),
    toml: (path) => parse(readFileSync(path, "utf8")),
    output: () => output,
    inHome(callback) {
      const previous = process.env.HOME; process.env.HOME = home;
      try { return callback(); }
      finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
    },
    async run(answers, hook = () => {}) {
      let index = 0;
      const result = await runSetupWizard({ home, env: {}, output: { write(text) { output += text; } }, question: async (prompt, options) => {
        assert.ok(index < answers.length, "Unexpected prompt: " + prompt);
        hook(prompt, options, index);
        return answers[index++];
      } });
      assert.equal(index, answers.length, "Unused answers");
      return result;
    },
  };
}
const single = (role = "2", scope = "1") => ["1", role, "https://memory.example", "memory-secret", scope];
const dual = (usage = "1", read = "1") => ["1", "3", "https://personal.example", "personal-secret", "https://team.example", "team-secret", usage, ...(usage === "3" ? ["1"] : []), read];
function plan(f, project) {
  return f.inHome(() => {
    const route = resolveProjectConfig({}, project);
    const path = route.env.OPENVIKING_CLI_CONFIG_FILE || join(f.state, "ovcli.conf");
    const cfg = sourceConfig("current", path, {}, route.cliFile);
    return resolveReadRouting(cfg, f.json(join(f.state, "read-routing.json")), project);
  });
}

test("team only can enable multiple explicit projects without personal or project keys", async (t) => {
  const f = fixture(t);
  const other = join(f.home, "other"); mkdirSync(other);
  const result = await f.run([...single("2", "2"), f.project, "2", other, "2", "", "y"], (prompt, options) => {
    if (prompt.startsWith("API Key")) assert.equal(options.secret, true);
  });
  assert.equal(result.written, true);
  assert.deepEqual(f.json(join(f.state, "ovcli.conf")), { url: "https://memory.example", api_key: "memory-secret" });
  const global = f.toml(join(f.home, ".codex/config.toml"));
  assert.equal(global.plugins[PLUGIN].enabled, false);
  assert.equal(global.mcp_servers["openviking-memory"].enabled, false);
  for (const project of [f.project, other]) {
    const config = f.toml(join(project, ".codex/config.toml"));
    assert.equal(config.plugins[PLUGIN].enabled, true);
    assert.equal(config.mcp_servers["openviking-memory"].enabled, true);
    assert.equal(config.plugins[PLUGIN].mcp_servers["openviking-memory"].enabled, false);
    assert.equal(existsSync(join(project, ".openviking")), false);
    assert.equal(plan(f, project).sources[0].config.apiKey, "memory-secret");
  }
  const routing = f.json(join(f.state, "read-routing.json"));
  assert.deepEqual(routing.sources, { team: join(f.state, "ovcli.conf") });
  assert.equal(existsSync(join(f.state, "project-configs.json")), false);
  assert.equal(existsSync(join(f.state, "read-sources")), false);
  assert.equal(routing.mode, "separate");
  assert.equal(statSync(join(f.state, "ovcli.conf")).mode & 0o777, 0o600);
  assert.equal(f.output().includes("memory-secret"), false);
});

for (const role of ["1", "2"]) {
  test("a single library can be the default for all projects: " + role, async (t) => {
    const f = fixture(t);
    await f.run([...single(role), "", "y"]);
    const config = f.toml(join(f.home, ".codex/config.toml"));
    assert.equal(config.plugins[PLUGIN].enabled, true);
    assert.equal(config.mcp_servers["openviking-memory"].enabled, true);
    assert.equal(f.json(join(f.state, "read-routing.json")).writeSource, role === "1" ? "local" : "team");
  });
}

test("ordinary projects use only personal memory and selected projects reuse team memory without copying keys", async (t) => {
  const f = fixture(t);
  let keysAsked = 0;
  await f.run([...dual(), f.project, "2", "1", "", "y"], (prompt) => { if (prompt.startsWith("API Key")) keysAsked++; });
  assert.equal(keysAsked, 2);
  const global = f.toml(join(f.home, ".codex/config.toml"));
  assert.equal(global.plugins[PLUGIN].enabled, true);
  assert.equal(global.mcp_servers["openviking-memory"].enabled, true);
  assert.equal(f.json(join(f.state, "ovcli.conf")).api_key, "personal-secret");
  const ordinary = plan(f, f.home);
  const team = plan(f, f.project);
  assert.equal(ordinary.mode, "separate");
  assert.equal(ordinary.sources[0].config.apiKey, "personal-secret");
  assert.equal(team.mode, "separate");
  assert.equal(team.sources[0].config.apiKey, "team-secret");
  assert.equal(existsSync(join(f.project, ".openviking")), false);
  assert.equal(existsSync(join(f.state, "project-configs.json")), false);
  assert.equal(f.output().includes("team-secret"), false);
  assert.match(f.output(), /全局默认：使用个人库/);
  assert.match(f.output(), /1 全局默认分开读取/);
  assert.match(f.output(), /2 全局默认一起读取/);
  assert.match(f.output(), /1 此项目分开读取/);
  assert.match(f.output(), /2 此项目一起读取/);
  assert.doesNotMatch(f.output(), /普通项目/);
});

test("default team and selected personal projects also reuse the saved library", async (t) => {
  const f = fixture(t);
  await f.run([...dual("2"), f.project, "1", "1", "", "y"]);
  assert.equal(plan(f, f.home).sources[0].config.apiKey, "team-secret");
  assert.equal(plan(f, f.project).sources[0].config.apiKey, "personal-secret");
});

for (const role of ["1", "2"]) {
  test("dual libraries with default disabled allow project roles to be selected independently: " + role, async (t) => {
    const f = fixture(t);
    await f.run([...dual("3"), f.project, role, "1", "", "y"]);
    assert.equal(f.toml(join(f.home, ".codex/config.toml")).plugins[PLUGIN].enabled, false);
    assert.equal(plan(f, f.project).sources[0].config.apiKey, role === "1" ? "personal-secret" : "team-secret");
    assert.match(f.output(), /全局默认：关闭记忆/);
  });
}

test("cross-library reads require an explicit global or project choice and still write to one library", async (t) => {
  const f = fixture(t);
  await f.run([...dual("1", "2"), f.project, "2", "1", "", "y"]);
  const ordinary = plan(f, f.home);
  assert.equal(ordinary.mode, "combined");
  assert.equal(ordinary.sources.length, 2);
  assert.equal(ordinary.sources.filter((s) => s.primary).length, 1);
  assert.equal(ordinary.sources.find((s) => s.primary).name, "local");
  assert.equal(plan(f, f.project).mode, "separate");
});

test("project-only editing reuses connections, can disable projects, and restores default inheritance", async (t) => {
  const f = fixture(t);
  await f.run([...dual(), f.project, "2", "1", "", "y"]);
  await f.run(["2", "1", "1", f.project, "5", "", "y"]);
  assert.match(f.output(), /1 保留当前全局默认设置/);
  assert.match(f.output(), /2 全局默认使用个人库/);
  assert.match(f.output(), /3 全局默认关闭记忆/);
  assert.match(f.output(), /此入口保留已保存的库连接和全局默认读取方式/);
  assert.equal(f.toml(join(f.project, ".codex/config.toml")).plugins[PLUGIN].enabled, false);
  await f.run(["2", "1", "1", f.project, "3", "", "y"]);
  const config = f.toml(join(f.project, ".codex/config.toml"));
  assert.equal(Object.hasOwn(config.plugins[PLUGIN], "enabled"), false);
  assert.equal(Object.hasOwn(config.mcp_servers["openviking-memory"], "enabled"), false);
  assert.equal(plan(f, f.project).sources[0].config.apiKey, "personal-secret");
  assert.equal(existsSync(join(f.project, ".openviking")), false);
});

for (const answers of [["3"], ["0"], [...single(), "", "n"]]) {
  test("preserve/cancel creates no configuration: " + answers[0] + " / " + answers.at(-1), async (t) => {
    const f = fixture(t);
    assert.equal((await f.run(answers)).written, false);
    assert.deepEqual(readdirSync(f.home), ["project"]);
  });
}

test("advanced project connection is ignored by Git, approved and used by the existing runtime", async (t) => {
  const f = fixture(t);
  assert.equal(spawnSync("git", ["init", "-q", f.project]).status, 0);
  await f.run([...single("2", "2"), f.project, "4", "https://project.example", "project-secret", "", "y"]);
  const path = join(f.project, ".openviking/ovcli.conf");
  assert.equal(f.json(join(f.state, "project-configs.json"))[path], "https://project.example");
  assert.equal(spawnSync("git", ["-C", f.project, "check-ignore", "-q", ".openviking/ovcli.conf"]).status, 0);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(f.inHome(() => projectEnvironment({}, f.project).OPENVIKING_CLI_CONFIG_FILE), path);
});

test("replacing an old custom project connection backs it up and removes its approval", async (t) => {
  const f = fixture(t);
  spawnSync("git", ["init", "-q", f.project]);
  const path = join(f.project, ".openviking/ovcli.conf");
  f.write(path, { url: "https://project.example", api_key: "old-secret" });
  f.write(join(f.state, "project-configs.json"), { [path]: "https://project.example" });
  f.write(join(f.state, "read-routing.json"), { mode: "separate", directories: { [f.project]: "separate" } });
  const result = await f.run([...single(), "2", f.project, "2", "", "y"]);
  assert.equal(existsSync(path), false);
  assert.deepEqual(f.json(join(f.state, "project-configs.json")), {});
  assert.ok(result.backups[path].startsWith(join(f.state, "setup-backups")));
  assert.equal(f.json(result.backups[path]).api_key, "old-secret");
  assert.equal(plan(f, f.project).sources[0].config.apiKey, "memory-secret");
});

test("legacy combined read overrides can be preserved while the ordinary default becomes single-library", async (t) => {
  const f = fixture(t);
  await f.run([...dual("1", "2"), f.project, "1", "2", "", "y"]);
  await f.run(["1", "2", "", "", "1", "1", "", "y"]);
  const route = f.json(join(f.state, "read-routing.json"));
  assert.equal(route.mode, "separate");
  assert.equal(route.directories[f.project], "combined");
  assert.equal(plan(f, f.project).sources.length, 2);
  assert.match(f.output(), /部分项目可能继续使用不同的库或跨库读取/);
});

test("invalid URLs are retried without displaying rejected secrets", async (t) => {
  const f = fixture(t);
  await f.run(["1", "1", "https://user:password@example.com?secret=bad", "https://valid.example", "secret", "1", "", "y"]);
  assert.equal(f.output().includes("password"), false);
  assert.equal(f.json(join(f.state, "ovcli.conf")).url, "https://valid.example");
});

test("malformed existing files and symlink directories are refused unchanged", async (t) => {
  const f = fixture(t);
  const path = join(f.state, "read-routing.json");
  f.write(path, "{");
  await assert.rejects(f.run([]), /Invalid JSON/);
  assert.equal(readFileSync(path, "utf8"), "{");
  rmSync(f.state, { recursive: true }); symlinkSync(f.project, f.state);
  await assert.rejects(f.run([]), /regular directory/);
  assert.deepEqual(readdirSync(f.project), []);
});

test("tracked credentials cannot be replaced by shared connections", async (t) => {
  const f = fixture(t);
  spawnSync("git", ["init", "-q", f.project]);
  const path = join(f.project, ".openviking/ovcli.conf");
  f.write(path, { url: "https://project.example", api_key: "secret" });
  spawnSync("git", ["-C", f.project, "add", ".openviking/ovcli.conf"]);
  await assert.rejects(f.run([...single(), f.project, "2"]), /Git 跟踪/);
  assert.equal(existsSync(f.state), false);
  assert.equal(f.json(path).api_key, "secret");
});

test("a changed file at confirmation aborts every write", async (t) => {
  const f = fixture(t);
  const path = join(f.state, "ovcli.conf");
  await assert.rejects(f.run([...single("1"), "", "y"], (prompt) => { if (prompt.startsWith("确认保存")) f.write(path, { url: "https://concurrent.example", api_key: "other" }); }), /changed during setup/);
  assert.equal(f.json(path).api_key, "other");
  assert.equal(existsSync(join(f.state, "read-routing.json")), false);
  assert.equal(existsSync(join(f.home, ".codex/config.toml")), false);
});

test("existing read-routing lock blocks saving without removing the other writer lock", async (t) => {
  const f = fixture(t);
  f.write(join(f.state, "read-routing.json.lock"), "another-writer");
  await assert.rejects(f.run([...single(), "", "y"]), /holds a lock/);
  assert.equal(readFileSync(join(f.state, "read-routing.json.lock"), "utf8"), "another-writer");
  assert.equal(existsSync(join(f.state, "ovcli.conf")), false);
});

test("MCP credential environment overrides are refused without revealing secrets", async (t) => {
  const f = fixture(t);
  const path = join(f.home, ".codex/config.toml");
  const text = '[mcp_servers.openviking-memory.env]\nOPENVIKING_API_KEY = "mcp-secret"\n';
  f.write(path, text);
  await assert.rejects(f.run(["1"]), /环境变量覆盖/);
  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal(f.output().includes("mcp-secret"), false);
});

test("failed Git verification rolls back credentials, approvals and project TOML", async (t) => {
  const f = fixture(t);
  spawnSync("git", ["init", "-q", f.project]);
  f.write(join(f.project, ".gitignore"), "!.openviking/\n!.openviking/ovcli.conf\n");
  const global = join(f.state, "ovcli.conf");
  f.write(global, { url: "https://old.example", api_key: "old-secret" });
  const before = readFileSync(global, "utf8");
  const exclude = join(f.project, ".git/info/exclude");
  const oldExclude = readFileSync(exclude, "utf8");
  await assert.rejects(f.run([...single("2", "2"), f.project, "4", "https://project.example", "project-secret", "", "y"]), /忽略检查失败/);
  assert.equal(readFileSync(global, "utf8"), before);
  assert.equal(readFileSync(exclude, "utf8"), oldExclude);
  assert.equal(existsSync(join(f.state, "project-configs.json")), false);
  assert.equal(existsSync(join(f.project, ".openviking/ovcli.conf")), false);
  assert.equal(existsSync(join(f.project, ".codex/config.toml")), false);
});

test("terminal input never echoes API keys through history", { timeout: 3000 }, async (t) => {
  const { PassThrough, Writable } = await import("node:stream");
  const f = fixture(t);
  const input = new PassThrough(); input.isTTY = true;
  const steps = [["这次要做什么", "1\r"], ["库方案", "1\r"], ["服务 URL", "https://personal.example\r"], ["API Key", "FAKE-SECRET-FOR-HISTORY\r"], ["个人库的使用范围", "\x1b[A\r"], ["要设置的项目路径", "\r"], ["确认保存", "n\r"]];
  let visible = ""; let index = 0;
  const output = new Writable({ write(chunk, encoding, done) {
    const text = chunk.toString(); visible += text;
    if (index < steps.length && text.startsWith(steps[index][0])) { const answer = steps[index++][1]; setImmediate(() => input.write(answer)); }
    done();
  } });
  output.isTTY = true;
  t.after(() => { input.destroy(); output.destroy(); });
  assert.equal((await runSetupWizard({ home: f.home, env: {}, input, output })).written, false);
  assert.equal(index, steps.length);
  assert.equal(visible.includes("FAKE-SECRET-FOR-HISTORY"), false);
});

test("plural credential source alias cannot silently override saved settings", async (t) => {
  const f = fixture(t);
  await assert.rejects(runSetupWizard({ home: f.home, env: { OPENVIKING_CREDENTIALS_SOURCE: "env" }, output: { write() {} }, question: async () => "1" }), /环境变量覆盖/);
  assert.equal(existsSync(f.state), false);
});

test("switching a child to a shared library cannot silently retain its parent's custom connection", async (t) => {
  const f = fixture(t);
  spawnSync("git", ["init", "-q", f.project]);
  const child = join(f.project, "child"); mkdirSync(child);
  const path = join(f.project, ".openviking/ovcli.conf");
  f.write(path, { url: "https://parent.example", api_key: "parent-secret" });
  f.write(join(f.state, "project-configs.json"), { [path]: "https://parent.example" });
  await assert.rejects(f.run([...single("2", "2"), child, "2", ""]), /父目录仍有独立连接/);
  assert.equal(existsSync(join(child, ".codex")), false);
});

test("incomplete rollback preserves concurrent edits and recovery backups remain outside projects", async (t) => {
  const fs = (await import("node:fs")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const f = fixture(t);
  spawnSync("git", ["init", "-q", f.project]);
  f.write(join(f.project, ".gitignore"), "!.openviking/\n!.openviking/ovcli.conf\n");
  const global = join(f.state, "ovcli.conf");
  const projectConf = join(f.project, ".openviking/ovcli.conf");
  f.write(global, { url: "https://old.example", api_key: "old-secret" });
  f.write(projectConf, { url: "https://old-project.example", api_key: "old-project-secret" });
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    rename(from, to);
    if (to === join(f.state, "read-routing.json")) f.write(global, { url: "https://concurrent.example", api_key: "concurrent-secret" });
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(f.run([...single("2", "2"), f.project, "4", "https://project.example", "project-secret", "", "y"]), /some files could not be restored/);
  assert.equal(f.json(global).api_key, "concurrent-secret");
  assert.deepEqual(readdirSync(join(f.project, ".openviking")), ["ovcli.conf"]);
  const directory = join(f.state, "setup-backups", readdirSync(join(f.state, "setup-backups"))[0]);
  const manifest = f.json(join(directory, "manifest.json"));
  assert.equal(f.json(manifest[projectConf]).api_key, "old-project-secret");
  assert.equal(statSync(manifest[projectConf]).mode & 0o777, 0o600);
});

test("project-only editing preserves mixed global switches and default reading byte for byte", async (t) => {
  const f = fixture(t);
  await f.run([...dual("1", "2"), "", "y"]);
  const path = join(f.home, ".codex/config.toml");
  const { stringify } = await import("smol-toml");
  const config = f.toml(path);
  config.mcp_servers["openviking-memory"].enabled = false;
  const before = stringify(config);
  f.write(path, before);
  await f.run(["2", "1", f.project, "2", "1", "", "y"]);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(f.json(join(f.state, "read-routing.json")).mode, "combined");
  assert.equal(plan(f, f.project).sources[0].config.apiKey, "team-secret");
});

test("restoring a child project to the ordinary default overrides an inherited shared-team selection", async (t) => {
  const f = fixture(t);
  const child = join(f.project, "child"); mkdirSync(child);
  await f.run([...dual(), f.project, "2", "1", child, "3", "", "y"]);
  assert.equal(plan(f, f.project).sources[0].config.apiKey, "team-secret");
  assert.equal(plan(f, child).sources[0].config.apiKey, "personal-secret");
});

test("project-only editing never reapproves a changed shared service address", async (t) => {
  const f = fixture(t);
  await f.run([...dual(), f.project, "2", "1", "", "y"]);
  const routingPath = join(f.state, "read-routing.json");
  const before = readFileSync(routingPath, "utf8");
  const teamPath = f.json(routingPath).sources.team;
  f.write(teamPath, { url: "https://unapproved.example", api_key: "changed-secret" });
  await assert.rejects(f.run(["2", "1", "1", ""]), /Invalid shared OpenViking connection/);
  assert.equal(readFileSync(routingPath, "utf8"), before);
  assert.equal(f.output().includes("changed-secret"), false);
});
