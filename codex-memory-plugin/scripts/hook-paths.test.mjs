import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../hooks/hooks.json", import.meta.url), "utf8"));
const commands = Object.entries(manifest.hooks).flatMap(([event, groups]) =>
  groups.flatMap((group) => group.hooks.map((hook) => ({ event, command: hook.command }))));

function run(command, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd, env, timeout: 5000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify({ source: "unknown", session_id: "unknown" }));
  });
}

test("all hook commands execute from a plugin path containing spaces", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ov-hook-paths-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const installed = join(root, "plugin with spaces");
  const guard = join(root, "no-network.cjs");
  await mkdir(home);
  await symlink(pluginRoot, installed, "dir");
  await writeFile(guard, `globalThis.fetch = () => {
    process.exitCode = 1;
    throw new Error("Unexpected network access in hook path test");
  };\n`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENVIKING_")));
  const env = {
    ...inherited, HOME: home, USERPROFILE: home, NODE_OPTIONS: "--require " + JSON.stringify(guard),
    OPENVIKING_CREDENTIAL_SOURCE: "env", OPENVIKING_URL: "http://127.0.0.1:1",
    OPENVIKING_API_KEY: "synthetic-hook-path-key", OPENVIKING_WORKSPACE_PEER: "0",
    OPENVIKING_AUTO_CAPTURE: "0", OPENVIKING_AUTO_RECALL: "0", OPENVIKING_AUTO_COMMIT_ON_COMPACT: "0",
    OPENVIKING_NO_AUTO_INJECT: "1", OPENVIKING_RESUME_ARCHIVE_INJECT: "0",
    OPENVIKING_RECALL_COMPRESS: "0", OPENVIKING_RECALL_COMPRESS_DETECT_ON_STARTUP: "0",
    OPENVIKING_WRITE_PATH_ASYNC: "0",
  };
  assert.equal(commands.length, 4);
  for (const mode of ["shell expansion", "Codex inline replacement"]) {
    for (const { event, command } of commands) {
      await t.test(`${event} with ${mode}`, async () => {
        const inline = mode === "Codex inline replacement";
        const result = await run(inline ? command.replaceAll("${PLUGIN_ROOT}", installed) : command,
          { ...env, PLUGIN_ROOT: inline ? "/unused-placeholder" : installed }, home);
        assert.equal(result.signal, null, result.stderr);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), {});
      });
    }
  }
});
