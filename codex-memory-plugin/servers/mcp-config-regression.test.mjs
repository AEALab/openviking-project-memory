import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("./mcp-proxy.mjs", import.meta.url));

async function fixture(t, { globalConnection = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ov-mcp-config-")));
  const home = join(root, "home");
  const project = join(home, "project");
  const configPath = join(globalConnection ? home : project, ".openviking", "ovcli.conf");
  const registryPath = join(home, ".openviking", "project-configs.json");
  const routingPath = join(home, ".openviking", "read-routing.json");
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const message = text ? JSON.parse(text) : null;
    calls.push({ method: req.method, message });
    if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "fixture-session" });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18" }
      : message.method === "tools/list" ? { tools: [{ name: "write" }] } : { content: [] };
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const config = {
    url, api_key: "synthetic-fixture-key", account: "fixture-account", user: "fixture-user",
    actor_peer_id: "fixture-peer", plugin: { codex: { recallPeerScope: "actor" } },
  };
  for (const dir of [dirname(registryPath), dirname(configPath), join(project, ".git")]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(registryPath, JSON.stringify(globalConnection ? {} : { [configPath]: url }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENVIKING_")));
  const child = spawn(process.execPath, [ENTRY], { cwd: project, env: { ...env, HOME: home, USERPROFILE: home } });
  const exited = once(child, "close");
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  t.after(async () => {
    child.stdin.end();
    const shutdown = setTimeout(() => child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(shutdown);
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  });
  let id = 0;
  async function rpc(method, params = {}) {
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`MCP response timed out: ${stderr}`));
      }, 3000);
      pending.set(requestId, (message) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(message);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    });
  }
  assert.equal((await rpc("initialize", { protocolVersion: "2025-06-18" })).error, undefined);
  assert.equal((await rpc("tools/call", { name: "write", arguments: { value: "permitted" } })).error, undefined);
  return { config, configPath, registryPath, routingPath, project, calls, rpc };
}

test("MCP accepts an unchanged connection when an unused server config appears", async (t) => {
  const f = await fixture(t);
  await writeFile(join(dirname(f.registryPath), "ov.conf"), "{}");
  const before = f.calls.length;
  assert.equal((await f.rpc("tools/call", { name: "write", arguments: { value: "same connection" } })).error, undefined);
  assert.equal(f.calls.length, before + 1);
});

test("MCP accepts equivalent URL spelling while retaining the existing connection", async (t) => {
  const f = await fixture(t);
  await writeFile(f.configPath, JSON.stringify({ ...f.config, url: f.config.url.replace("http:", "HTTP:") }));
  const before = f.calls.length;
  assert.equal((await f.rpc("tools/call", { name: "write", arguments: { value: "same endpoint" } })).error, undefined);
  assert.equal(f.calls.length, before + 1);
});

test("MCP accepts an identical approved project connection and still enforces its enrollment", async (t) => {
  const f = await fixture(t, { globalConnection: true });
  const projectPath = join(f.project, ".openviking", "ovcli.conf");
  await mkdir(dirname(projectPath), { recursive: true });
  await writeFile(projectPath, JSON.stringify(f.config));
  await writeFile(f.registryPath, JSON.stringify({ [projectPath]: f.config.url }));
  assert.equal((await f.rpc("tools/list")).error, undefined);
  assert.equal((await f.rpc("tools/call", { name: "write", arguments: { value: "same connection" } })).error, undefined);
  await writeFile(f.registryPath, "{}");
  const before = f.calls.length;
  assert.ok((await f.rpc("tools/call", { name: "write", arguments: { value: "must not send" } })).error);
  assert.equal(f.calls.length, before);
});

const changes = [
  ["project enrollment is revoked", async (f) => writeFile(f.registryPath, "{}"), /Invalid project OpenViking config/],
  ["project config is removed", async (f) => rm(f.configPath), /Invalid project OpenViking config/],
  ["project config becomes malformed", async (f) => writeFile(f.configPath, "{"), /Invalid project OpenViking config/],
  ["project API key changes", async (f) => writeFile(f.configPath, JSON.stringify({ ...f.config, api_key: "synthetic-rotated-key" })), /connection changed/],
  ["project URL changes with approval", async (f) => {
    const url = f.config.url + "/changed";
    await writeFile(f.configPath, JSON.stringify({ ...f.config, url }));
    await writeFile(f.registryPath, JSON.stringify({ [f.configPath]: url }));
  }, /connection changed/],
  ...["account", "user", "actor_peer_id"].map((field) => [
    `project ${field} changes`, async (f) => writeFile(f.configPath, JSON.stringify({ ...f.config, [field]: "changed" })), /connection changed/,
  ]),
  ["read mode changes from separate to combined", async (f) => writeFile(f.routingPath, JSON.stringify({
    mode: "combined", sources: { local: f.configPath, team: f.configPath },
  })), /read configuration changed/],
];

for (const [name, mutate, expected] of changes) {
  test(`single-source MCP rejects tools before HTTP when ${name}`, { timeout: 10000 }, async (t) => {
    const f = await fixture(t);
    await mutate(f);
    const before = f.calls.length;
    for (const [method, params] of [
      ["tools/call", { name: "write", arguments: { value: "must not send" } }], ["tools/list", {}],
    ]) {
      const response = await f.rpc(method, params);
      assert.ok(response.error, JSON.stringify(response));
      assert.match(JSON.stringify(response.error), expected);
    }
    assert.equal(f.calls.length, before);
  });
}
