// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_PROXY = join(SCRIPT_DIR, "../servers/mcp-proxy.mjs");
const HOOK_SCRIPTS = ["auto-recall.mjs", "auto-capture.mjs", "session-start-commit.mjs", "pre-compact-capture.mjs"]
  .map((name) => join(SCRIPT_DIR, name));

async function mockServer(t, name) {
  const calls = [];
  const apiKey = `synthetic-${name}-key`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path: req.url, headers: req.headers, body });
    const respond = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      respond(401, { status: "error", error: "wrong synthetic key" });
    } else if (req.url === "/health") {
      respond(200, { status: "ok", result: { ok: true } });
    } else if (["/api/v1/search/search", "/api/v1/search/recall"].includes(req.url)) {
      respond(200, {
        status: "ok",
        result: {
          rendered: `- Synthetic ${name} memory`,
          entries: [{ uri: `viking://resources/${name}`, text: `Synthetic ${name} memory`, score: 1 }],
        },
      });
    } else if (/^\/api\/v1\/sessions\/cx-routing-\w+\/messages\/batch$/.test(req.url)) {
      respond(200, { status: "ok", result: { ok: true } });
    } else if (/^\/api\/v1\/sessions\/cx-routing-\w+$/.test(req.url)) {
      respond(200, { status: "ok", result: { pending_tokens: 2, total_message_count: 2 } });
    } else if (req.url === "/mcp" && req.method === "DELETE") {
      respond(200, {});
    } else if (req.url === "/mcp" && body?.method === "initialize") {
      res.setHeader("Mcp-Session-Id", `synthetic-${name}-session`);
      respond(200, {
        jsonrpc: "2.0", id: body.id,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name, version: "1" } },
      });
    } else if (req.url === "/mcp" && body?.method === "tools/list") {
      respond(200, { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: `${name}_tool` }] } });
    } else {
      respond(404, { status: "error", error: "unexpected synthetic endpoint" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { name, apiKey, calls, url: `http://127.0.0.1:${server.address().port}` };
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ov-project-routing-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const normal = join(home, "normal-repo");
  const team = join(home, "team-repo");
  const nested = join(team, "src", "nested");
  const localServer = await mockServer(t, "local");
  const teamServer = await mockServer(t, "team");
  const teamConfig = join(team, ".openviking", "ovcli.conf");
  for (const path of [join(home, ".openviking"), join(normal, ".git"), join(team, ".git"), dirname(teamConfig), nested]) {
    await mkdir(path, { recursive: true });
  }
  const config = (server) => JSON.stringify({
    url: server.url, api_key: server.apiKey,
    plugin: { codex: { recallCompress: false, writePathAsync: false, workspacePeer: false } },
  });
  await writeFile(join(home, ".openviking", "ovcli.conf"), config(localServer));
  await writeFile(teamConfig, config(teamServer));
  await writeFile(join(home, ".openviking", "project-configs.json"), JSON.stringify({ [teamConfig]: teamServer.url }));
  const transcript = join(root, "synthetic-transcript.jsonl");
  await writeFile(transcript, [
    { payload: { message: { role: "user", content: "Remember this synthetic routing fixture." } } },
    { payload: { message: { role: "assistant", content: "Synthetic routing fixture recorded." } } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENVIKING_")) delete env[key];
  }
  return { home, normal, team, nested, teamConfig, transcript, env, localServer, teamServer };
}

function runScript(script, cwd, env, input, { mcp = false, args = [] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let requestedTools = false;
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!mcp) return;
      for (const line of stdout.split("\n").slice(0, -1)) {
        const message = JSON.parse(line);
        if (message.id === 1 && !requestedTools) {
          requestedTools = true;
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
        }
        if (message.id === 2) child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    if (mcp) {
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "routing-test", version: "1" } },
      }) + "\n");
    } else {
      child.stdin.end(JSON.stringify(input));
    }
  });
}

function assertSuccess(result) {
  assert.equal(result.signal, null, result.stderr || "child timed out");
  assert.equal(result.code, 0, result.stderr);
}

test("real hooks and MCP proxy route by project and isolate backend session state", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const scenarios = [
    [f.normal, f.localServer, f.teamServer, true],
    [f.team, f.teamServer, f.localServer, true],
    [f.nested, f.teamServer, f.localServer, false],
  ];
  for (const [cwd, target, other, firstCapture] of scenarios) {
    const targetStart = target.calls.length;
    const otherStart = other.calls.length;
    const sessionId = `routing-${target.name}`;
    const recall = await runScript(join(SCRIPT_DIR, "auto-recall.mjs"), cwd, f.env, {
      session_id: sessionId, prompt: "Recall the synthetic routing fixture.",
    });
    assertSuccess(recall);
    assert.match(JSON.parse(recall.stdout).hookSpecificOutput.additionalContext, new RegExp(`Synthetic ${target.name} memory`));
    const capture = await runScript(join(SCRIPT_DIR, "auto-capture.mjs"), cwd, f.env, {
      session_id: sessionId, transcript_path: f.transcript,
    });
    assertSuccess(capture);
    if (firstCapture) assert.match(JSON.parse(capture.stdout).systemMessage, /appended 2 turn\(s\)/);
    else assert.deepEqual(JSON.parse(capture.stdout), {});
    const proxy = await runScript(MCP_PROXY, cwd, f.env, null, { mcp: true });
    assertSuccess(proxy);
    const messages = proxy.stdout.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(messages.find((message) => message.id === 1).result.serverInfo.name, target.name);
    assert.deepEqual(messages.find((message) => message.id === 2).result.tools, [{ name: `${target.name}_tool` }]);
    const calls = target.calls.slice(targetStart);
    assert.equal(other.calls.length, otherStart, `${cwd} contacted the other backend`);
    assert.ok(calls.some((call) => call.path.startsWith("/api/v1/search/")));
    const batch = calls.find((call) => call.path.endsWith("/messages/batch"));
    if (firstCapture) assert.deepEqual(batch.body.messages.map((message) => message.role), ["user", "assistant"]);
    else assert.equal(batch, undefined, "nested cwd must reuse team capture state");
    assert.deepEqual(calls.filter((call) => call.path === "/mcp" && call.method === "POST").map((call) => call.body.method), ["initialize", "tools/list"]);
    for (const call of calls) assert.equal(call.headers.authorization, `Bearer ${target.apiKey}`);
  }
  const callCounts = [f.localServer.calls.length, f.teamServer.calls.length];
  for (const script of HOOK_SCRIPTS) {
    const result = await runScript(script, f.nested, f.env, {
      session_id: "routing-local", source: "resume", prompt: "Synthetic prompt", transcript_path: f.transcript,
    });
    assertSuccess(result);
    assert.deepEqual(JSON.parse(result.stdout), {}, "a session bound to local must not replay its history to team");
    assert.deepEqual([f.localServer.calls.length, f.teamServer.calls.length], callCounts);
  }
  const stateRoot = join(f.home, ".openviking", "codex-plugin-state");
  const scopes = (await readdir(stateRoot)).filter((name) => /^[a-f0-9]{16}$/.test(name));
  assert.equal(scopes.length, 2, "local and team must have separate state directories");
  assert.notEqual(scopes[0], scopes[1]);
  for (const scope of scopes) {
    const files = await readdir(join(stateRoot, scope));
    assert.equal(files.length, 1);
    const state = JSON.parse(await readFile(join(stateRoot, scope, files[0]), "utf8"));
    assert.ok(["routing-local", "routing-team"].includes(state.codexSessionId));
    assert.equal(state.capturedTurnCount, 2);
  }
});

test("malformed, unenrolled, or missing project config blocks hooks and MCP before HTTP", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const validConfig = await readFile(f.teamConfig, "utf8");
  for (const kind of ["malformed", "unenrolled", "missing"]) {
    await writeFile(f.teamConfig, kind === "malformed" ? "{" : validConfig);
    await writeFile(join(f.home, ".openviking", "project-configs.json"), JSON.stringify(
      kind === "unenrolled" ? {} : { [f.teamConfig]: f.teamServer.url },
    ));
    if (kind === "missing") await rm(f.teamConfig);
    for (const script of [...HOOK_SCRIPTS, MCP_PROXY]) {
      const result = await runScript(script, f.nested, f.env, {
        session_id: "routing-team", source: "resume", prompt: "Synthetic prompt", transcript_path: f.transcript,
      }, { mcp: script === MCP_PROXY });
      assert.equal(result.signal, null, result.stderr);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Invalid project OpenViking config/);
      assert.equal(result.stdout, "");
    }
  }
  assert.deepEqual(f.localServer.calls, []);
  assert.deepEqual(f.teamServer.calls, []);
});

test("MCP config remains pinned when an approved project's URL or key changes", { timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const program = `
    import assert from "node:assert/strict";
    import { readFileSync, writeFileSync } from "node:fs";
    const { readProxyConfig } = await import(${JSON.stringify(pathToFileURL(MCP_PROXY).href)});
    const configPath = ${JSON.stringify(f.teamConfig)};
    const registryPath = ${JSON.stringify(join(f.home, ".openviking", "project-configs.json"))};
    const original = JSON.parse(readFileSync(configPath, "utf8"));
    const first = readProxyConfig();
    assert.equal(first.apiKey, original.api_key);
    assert.equal(first.mcpUrl, original.url + "/mcp");
    assert.equal(readProxyConfig().mcpUrl, first.mcpUrl);
    for (const change of [
      { url: ${JSON.stringify(f.localServer.url)} },
      { api_key: "synthetic-rotated-team-key" },
    ]) {
      const changed = { ...original, ...change };
      writeFileSync(configPath, JSON.stringify(changed));
      writeFileSync(registryPath, JSON.stringify({ [configPath]: changed.url }));
      assert.throws(() => readProxyConfig(), /OpenViking connection changed/);
    }
  `;
  const result = await runScript("--input-type=module", f.nested, f.env, null, { args: ["-e", program] });
  assertSuccess(result);
  assert.equal(result.stdout, "");
  assert.deepEqual(f.localServer.calls, []);
  assert.deepEqual(f.teamServer.calls, []);
});
