// Community modification (2026-11-05): isolated offline activation-scope regressions.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");
const PLUGIN_ID = "openviking-memory@openviking-project";

async function fixture(t, { enabled = false, projectEnabled, trust, mcpEnabled = enabled, bundledEnabled = false, cliEnabled = enabled, globalConnection = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ov-doctor-test-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  const cwd = join(project, "child");
  const bin = join(root, "bin");
  await Promise.all([
    mkdir(join(home, ".codex"), { recursive: true }),
    mkdir(join(home, ".openviking"), { recursive: true }),
    mkdir(join(project, ".git"), { recursive: true }),
    mkdir(join(project, ".codex"), { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(bin),
  ]);
  await writeFile(join(home, ".codex", "config.toml"), `
[features]
plugin_hooks = true
[plugins."${PLUGIN_ID}"]
enabled = ${enabled} # user-level default
[plugins."${PLUGIN_ID}".mcp_servers.openviking-memory]
enabled = ${bundledEnabled}
[mcp_servers.openviking-memory]
enabled = ${mcpEnabled}
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(join(PLUGIN_ROOT, "servers", "mcp-proxy.mjs"))}]
${trust ? `[projects."${project}"]\ntrust_level = "${trust}"` : ""}
`);
  if (projectEnabled !== undefined) await writeFile(join(project, ".codex", "config.toml"), `
[plugins."${PLUGIN_ID}"]
enabled = ${projectEnabled}
[mcp_servers.openviking-memory]
enabled = ${projectEnabled}
`);
  const connectionDir = globalConnection || projectEnabled === undefined ? join(home, ".openviking") : join(project, ".openviking");
  if (enabled || projectEnabled || globalConnection) {
    await mkdir(connectionDir, { recursive: true });
    const connectionPath = join(connectionDir, "ovcli.conf");
    await writeFile(connectionPath, JSON.stringify({ url: "http://127.0.0.1:9", api_key: "fixture-key-never-sent" }), { mode: 0o600 });
    if (projectEnabled && !globalConnection) await writeFile(join(home, ".openviking", "project-configs.json"), JSON.stringify({ [connectionPath]: "http://127.0.0.1:9" }));
  }
  await writeFile(join(bin, "codex"), `#!${process.execPath}
const args = process.argv.slice(2).join(" ");
if (args === "--version") console.log("codex fixture");
else if (args === "plugin list --json") console.log(JSON.stringify({ installed: [{ pluginId: ${JSON.stringify(PLUGIN_ID)}, name: "openviking-memory", installed: true, enabled: ${cliEnabled}, source: { path: ${JSON.stringify(PLUGIN_ROOT)} } }] }));
else if (args === "plugin marketplace list --json") console.log(JSON.stringify({ marketplaces: [{ name: "openviking-project", root: ${JSON.stringify(resolve(PLUGIN_ROOT, ".."))}, marketplaceSource: { sourceType: "local", source: ${JSON.stringify(resolve(PLUGIN_ROOT, ".."))} } }] }));
else process.exit(2);
`);
  await chmod(join(bin, "codex"), 0o755);
  const guard = join(root, "offline-guard.cjs");
  await writeFile(guard, 'globalThis.fetch = () => { throw new Error("offline doctor attempted HTTP"); };');
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENVIKING_") || key.startsWith("CODEX_") || key.startsWith("NODE_") || /proxy/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, CODEX_HOME: join(home, ".codex"),
    PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
    NODE_OPTIONS: `--require=${guard}`,
  });
  return {
    home, project, cwd,
    async run() {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(SCRIPT_DIR, "ov-memory-doctor.mjs"), "--json", "--offline"], { env, cwd });
      assert.equal(stderr, "");
      const report = JSON.parse(stdout);
      const findings = report.sections.flatMap((section) => section.findings);
      assert.deepEqual(findings.filter((finding) => finding.level === "fail"), []);
      assert.doesNotMatch(stdout, /curl[^\n]*install\.sh|re-run the installer|set enabled = true|set \[plugins[^\n]*enabled = true/);
      return { report, findings, text: stdout };
    },
  };
}

test("project-only mode inherits independent MCP command with global plugin and MCP disabled", async (t) => {
  const f = await fixture(t, { projectEnabled: true, trust: "trusted" });
  const { report, findings, text } = await f.run();
  assert.match(text, /user-level plugin default is disabled/);
  assert.match(text, /plugin configured enabled in current project configuration/);
  assert.match(text, /independent MCP launch command\/args are configured/);
  assert.match(text, /bundled plugin MCP is disabled/);
  assert.equal(report.resolved.baseUrl, "http://127.0.0.1:9");
  assert.ok(findings.some((finding) => finding.title.includes("ovcli.conf:") && finding.title.includes("project/.openviking/ovcli.conf")));
  assert.doesNotMatch(text, /trust is not verified|nothing listens|no usable config/);
});

test("ordinary directories keep both defaults disabled without any global connection", async (t) => {
  const f = await fixture(t);
  const { report, text } = await f.run();
  assert.equal(report.resolved, null);
  assert.match(text, /plugin is disabled for the current directory/);
  assert.match(text, /independent MCP is disabled for the current directory/);
  assert.match(text, /project-only mode does not require a global OpenViking connection/);
  assert.doesNotMatch(text, /create ~\/.openviking\/ovcli.conf|nothing listens|no usable config/);
});

test("project-only mode uses the global connection without a project connection or registry", async (t) => {
  const f = await fixture(t, { projectEnabled: true, trust: "trusted", globalConnection: true });
  const { report, findings, text } = await f.run();
  assert.equal(report.resolved.baseUrl, "http://127.0.0.1:9");
  assert.match(text, /user-level plugin default is disabled/);
  assert.match(text, /plugin configured enabled in current project configuration/);
  assert.match(text, /independent MCP launch command\/args are configured/);
  assert.match(text, /bundled plugin MCP is disabled/);
  assert.ok(findings.some((finding) => finding.title.startsWith("ovcli.conf: ~/.openviking/ovcli.conf (mode 600,")));
  assert.doesNotMatch(text, /trust is not verified|nothing listens|no usable config/);
});

test("ordinary directories keep both defaults disabled even with a global connection", async (t) => {
  const f = await fixture(t, { globalConnection: true });
  const { report, text } = await f.run();
  assert.equal(report.resolved, null);
  assert.match(text, /plugin is disabled for the current directory/);
  assert.match(text, /independent MCP is disabled for the current directory/);
});

test("normal global mode keeps its independent MCP enabled", async (t) => {
  const f = await fixture(t, { enabled: true });
  const { report, text } = await f.run();
  assert.equal(report.resolved.baseUrl, "http://127.0.0.1:9");
  assert.match(text, /plugin configured enabled in user configuration/);
  assert.match(text, /independent MCP launch command\/args are configured/);
  assert.doesNotMatch(text, /user-level plugin default is disabled|project config trust/);
});

test("project files without a trust record are configured but not proven active", async (t) => {
  const f = await fixture(t, { projectEnabled: true });
  const { findings, text } = await f.run();
  assert.ok(findings.some((finding) => finding.level === "warn" && finding.title.includes("trust is not verified")));
  assert.match(text, /configured overrides may not be loaded/);
  assert.doesNotMatch(text, /all four hooks have trust records/);
});

test("explicitly untrusted project overrides are ignored", async (t) => {
  const f = await fixture(t, { projectEnabled: true, trust: "untrusted" });
  const { report, text } = await f.run();
  assert.equal(report.resolved, null);
  assert.match(text, /project config is untrusted; its overrides are ignored/);
  assert.doesNotMatch(text, /plugin configured enabled in current project/);
});

test("project-only defaults warn if the independent MCP stays enabled", async (t) => {
  const f = await fixture(t, { mcpEnabled: true });
  const { findings } = await f.run();
  assert.ok(findings.some((finding) => finding.level === "warn" && finding.title.includes("independent MCP remains enabled")));
});
