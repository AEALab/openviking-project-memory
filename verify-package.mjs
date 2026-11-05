import assert from "node:assert/strict";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_FILE_COUNT = 97; // Updated together with the release file manifest.

export function verifyPackage(directory) {
  const root = resolve(directory);
  function pathFor(path) {
    assert.equal(typeof path, "string", "Invalid package path");
    const full = resolve(root, path);
    assert.ok(!isAbsolute(path) && relative(root, full).split(sep).join("/") === path
      && path !== ".." && !path.startsWith("../"), "Unsafe package path: " + path);
    return full;
  }
  const readJson = (path) => JSON.parse(readFileSync(pathFor(path), "utf8"));
  const requireFile = (path) => {
    assert.ok(lstatSync(pathFor(path)).isFile(), "Missing package file: " + path);
    return path;
  };
  const actual = [];
  function walk(directory, prefix = "") {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!prefix && entry.name === ".git") continue;
      const path = prefix + entry.name;
      assert.ok(!entry.isSymbolicLink(), "Package symlinks are not allowed: " + path);
      if (entry.isDirectory()) walk(join(directory, entry.name), path + "/");
      else { assert.ok(entry.isFile(), "Unsupported package entry: " + path); actual.push(path); }
    }
  }
  walk(root);
  assert.equal(actual.length, EXPECTED_FILE_COUNT, "Unexpected package file count");

  const catalog = readJson(".agents/plugins/marketplace.json");
  assert.equal(catalog.name, "openviking-project");
  const manifest = readJson("codex-memory-plugin/.codex-plugin/plugin.json");
  assert.equal(manifest.name, catalog.plugins[0].name);
  assert.equal(manifest.version, "0.7.7-project.4");
  assert.equal(catalog.plugins[0].source.path, "./codex-memory-plugin");
  for (const path of ["LICENSE", "NOTICE.md", "README.md", "ov-memory.mjs",
    "codex-memory-plugin/scripts/ov-memory.mjs", "codex-memory-plugin/scripts/read-routing.mjs",
    "codex-memory-plugin/servers/combined-read.mjs"]) requireFile(path);
  const pluginPath = (path) => "codex-memory-plugin/" + path.replace(/^\.\//, "");
  const hooks = readJson(requireFile(pluginPath(manifest.hooks)));
  const hookScripts = { SessionStart: "session-start-commit.mjs", UserPromptSubmit: "auto-recall.mjs",
    Stop: "auto-capture.mjs", PreCompact: "pre-compact-capture.mjs" };
  assert.deepEqual(Object.keys(hooks.hooks).sort(), Object.keys(hookScripts).sort());
  for (const [event, script] of Object.entries(hookScripts)) {
    const hook = hooks.hooks[event][0].hooks[0];
    assert.equal(hook.command, 'node "${PLUGIN_ROOT}/scripts/' + script + '"', "Invalid hook command: " + event);
    requireFile("codex-memory-plugin/scripts/" + script);
  }
  const mcp = readJson(requireFile(pluginPath(manifest.mcpServers))).mcpServers["openviking-memory"];
  assert.equal(mcp.command, "node");
  assert.equal(mcp.cwd, ".");
  assert.deepEqual(mcp.args, ["servers/mcp-proxy.mjs"]);
  requireFile(pluginPath(mcp.args[0]));
  assert.equal(manifest.skills, "./skills/");
  for (const name of ["openviking-memory", "ov-experience-memory", "ov-memory", "ov-memory-doctor"]) {
    const path = requireFile(pluginPath("skills/" + name + "/SKILL.md"));
    assert.ok(readFileSync(pathFor(path), "utf8").startsWith("---\nname: " + name + "\n"),
      "Invalid skill metadata: " + name);
  }
  const sums = readJson("SHA256SUMS.json");
  assert.ok(sums && typeof sums === "object" && !Array.isArray(sums), "Invalid checksum manifest");
  assert.deepEqual(Object.keys(sums).sort(), actual.filter((path) => path !== "SHA256SUMS.json").sort(),
    "Checksum manifest must cover every package file exactly once");
  for (const [path, expected] of Object.entries(sums)) {
    assert.match(expected, /^[a-f0-9]{64}$/, "Invalid checksum: " + path);
    assert.equal(createHash("sha256").update(readFileSync(pathFor(path))).digest("hex"),
      expected, "Changed package file: " + path);
  }
  return Object.keys(sums).length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = verifyPackage(dirname(fileURLToPath(import.meta.url)));
  console.log("Package structure and checksums passed (" + count + " files).");
}
