// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const COLLIDING_URI = "viking://~/memories/preferences/shared.md";

async function fakeServer(name, behavior = "context") {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "null");
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push({ path: url.pathname, method: req.method, headers: req.headers, body, uri: url.searchParams.get("uri") });
    const reply = (result, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: status === 200 ? "ok" : "error", result }));
    };
    if (url.pathname === "/health") return reply({ healthy: true });
    if (url.pathname === "/api/v1/system/status") return reply({ user: `${name}-user` });
    if (url.pathname === "/api/v1/fs/ls") {
      return reply(url.searchParams.get("uri") === "viking://user"
        ? [{ name: `${name}-user`, isDir: true }] : []);
    }
    if (url.pathname === "/api/v1/content/read") {
      return reply(url.searchParams.get("uri")?.endsWith("profile.md")
        ? `${name} unique profile` : `${name} fallback memory`);
    }
    if (url.pathname.endsWith("/commit")) return reply({ archived: true });
    if (url.pathname.endsWith("/context")) return reply({ latest_archive_overview: `${name} archive` });
    const entry = { uri: COLLIDING_URI, text: `${name} unique memory`, category: "preferences", score: 0.9, level: 2 };
    if (url.pathname === "/api/v1/search/search") {
      if (body.mode === "context") {
        if (behavior === "stall") return;
        return behavior === "context"
          ? reply({ rendered: `- ${name} unique memory (${COLLIDING_URI})`, entries: [entry] })
          : reply({}, 404);
      }
      return reply({ memories: body.target_uri.endsWith("/memories")
        ? [{ ...entry, abstract: `${name} fallback abstract` }] : [], skills: [] });
    }
    if (url.pathname === "/api/v1/search/recall") {
      return behavior === "recall"
        ? reply({ rendered: `- ${name} unique memory`, entries: [entry] }) : reply({}, 404);
    }
    reply({}, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fixture(fn, { mode = "combined", behavior = "context", teamBehavior = behavior } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ov-combined-hooks-"));
  const local = await fakeServer("local", behavior);
  const team = await fakeServer("team", teamBehavior);
  const stateDir = join(home, "state");
  const ovDir = join(home, ".openviking");
  await mkdir(ovDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const configs = {};
  for (const [name, server] of Object.entries({ local, team })) {
    configs[name] = join(ovDir, `${name}.ovcli.conf`);
    await writeFile(configs[name], JSON.stringify({
      url: server.url, api_key: `fake-${name}-key`, account: `${name}-account`,
      user: `${name}-user`, peer_id: `${name}-peer`,
      plugin: { codex: { authMode: "trusted" } },
    }));
  }
  const routingPath = join(ovDir, "read-routing.json");
  await writeFile(routingPath, JSON.stringify({ mode, sources: configs }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENVIKING_")));
  Object.assign(env, {
    HOME: home, OPENVIKING_CREDENTIAL_SOURCE: "cli", OPENVIKING_CLI_CONFIG_FILE: configs.local,
    OPENVIKING_CONFIG_FILE: join(home, "missing.ov.conf"), OPENVIKING_CODEX_STATE_DIR: stateDir,
    OPENVIKING_STATE_DIR: stateDir, OPENVIKING_AUTH_MODE: "trusted",
    OPENVIKING_AUTO_RECALL: "1", OPENVIKING_RECALL_COMPRESS: "0",
    OPENVIKING_RECALL_COMPRESS_DETECT_ON_STARTUP: "0", OPENVIKING_TIMEOUT_MS: "1000",
    OPENVIKING_CAPTURE_TIMEOUT_MS: "1000", OPENVIKING_RECALL_TIMEOUT_MS: "15000",
  });
  const run = (script, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SCRIPT_DIR, script)], { env, cwd: home, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${script} exited ${code}: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout.trim())); } catch (error) { reject(error); }
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
  try { await fn({ home, local, team, stateDir, routingPath, configs, env, run }); }
  finally { await Promise.all([local.close(), team.close()]); await rm(home, { recursive: true, force: true }); }
}

function context(output) { return output.hookSpecificOutput?.additionalContext || ""; }
const recallInput = { prompt: "Which implementation preferences do I have?", session_id: "combined-session" };
const startupInput = { source: "startup", session_id: "combined-session", cwd: "/tmp/combined-project" };

function assertIdentities(server, name) {
  assert.ok(server.requests.length > 0);
  for (const request of server.requests) {
    assert.equal(request.headers.authorization, `Bearer fake-${name}-key`);
    assert.equal(request.headers["x-openviking-account"], `${name}-account`);
    assert.equal(request.headers["x-openviking-user"], `${name}-user`);
    assert.equal(request.headers["x-openviking-actor-peer"], `${name}-peer`);
  }
}

test("combined hooks retain colliding URIs and source identities while commit/cursor stay primary", async () => {
  await fixture(async ({ local, team, run, stateDir }) => {
    const recalled = context(await run("auto-recall.mjs", recallInput));
    assert.match(recalled, /name="local"/);
    assert.match(recalled, /name="team"/);
    assert.match(recalled, /local unique memory/);
    assert.match(recalled, /team unique memory/);
    assert.equal(recalled.split(COLLIDING_URI).length - 1, 2);
    assert.ok(recalled.length <= 6500);
    assert.equal(local.requests.filter((r) => r.body?.mode === "context").length, 1);
    assert.equal(team.requests.filter((r) => r.body?.mode === "context").length, 1);
    assert.equal(local.requests.find((r) => r.body?.mode === "context").body.session_id, "cx-combined-session");
    assert.ok(team.requests.every((r) => !r.body?.session_id));

    await run("auto-recall.mjs", { prompt: "", session_id: "old-session" });
    const old = { codexSessionId: "old-session", ovSessionId: "cx-old-session", capturedTurnCount: 3, lastUpdatedAt: Date.now() };
    await writeFile(join(stateDir, "old-session.json"), JSON.stringify(old));
    const started = context(await run("session-start-commit.mjs", startupInput));
    assert.match(started, /local unique profile/);
    assert.match(started, /team unique profile/);
    assert.ok(local.requests.some((r) => r.path.endsWith("/cx-old-session/commit")));
    assert.ok(team.requests.every((r) => !r.path.includes("/sessions/")));
    const saved = JSON.parse(await readFile(join(stateDir, "old-session.json"), "utf8"));
    assert.equal(saved.ovSessionId, null);
    assert.equal(saved.capturedTurnCount, 3);
    assert.deepEqual((await readdir(stateDir)).filter((name) => name.endsWith(".json")).sort(), ["combined-session.json", "old-session.json"]);
    assertIdentities(local, "local");
    assertIdentities(team, "team");
    assert.ok(team.requests.filter((r) => r.uri && r.uri !== "viking://user").every((r) => !r.uri.includes("local-user")));
  });
});

test("separate hooks only read the active project source", async () => {
  await fixture(async ({ local, team, run }) => {
    assert.match(context(await run("auto-recall.mjs", recallInput)), /local unique memory/);
    assert.match(context(await run("session-start-commit.mjs", startupInput)), /local unique profile/);
    assert.equal(team.requests.length, 0);
    assertIdentities(local, "local");
  }, { mode: "separate" });
});

test("missing routing configuration retains separate reads", async () => {
  await fixture(async ({ team, run, routingPath }) => {
    await rm(routingPath);
    assert.match(context(await run("auto-recall.mjs", recallInput)), /local unique memory/);
    assert.match(context(await run("session-start-commit.mjs", startupInput)), /local unique profile/);
    assert.equal(team.requests.length, 0);
  });
});

test("identical configured sources are read only once", async () => {
  await fixture(async ({ local, team, run, routingPath, configs }) => {
    await writeFile(routingPath, JSON.stringify({ mode: "combined", sources: { local: configs.local, team: configs.local } }));
    assert.match(context(await run("auto-recall.mjs", recallInput)), /local unique memory/);
    assert.equal(local.requests.filter((r) => r.body?.mode === "context").length, 1);
    assert.equal(team.requests.length, 0);
  });
});

for (const behavior of ["recall", "fallback"]) {
  test(`combined recall preserves both sources through ${behavior} fallback`, async () => {
    await fixture(async ({ local, team, run }) => {
      const recalled = context(await run("auto-recall.mjs", recallInput));
      assert.match(recalled, behavior === "recall" ? /local unique memory/ : /local fallback memory/);
      assert.match(recalled, behavior === "recall" ? /team unique memory/ : /team fallback memory/);
      assert.ok(team.requests.every((r) => !r.body?.session_id));
      assertIdentities(local, "local");
      assertIdentities(team, "team");
    }, { behavior });
  });
}

test("an offline primary does not discard secondary recall or startup profile", async () => {
  await fixture(async ({ local, run }) => {
    await local.close();
    local.close = async () => {};
    assert.match(context(await run("auto-recall.mjs", recallInput)), /team unique memory/);
    assert.match(context(await run("session-start-commit.mjs", startupInput)), /team unique profile/);
  });
});

test("a stalled secondary cannot consume the hook deadline and discard primary recall", async () => {
  await fixture(async ({ run, env }) => {
    env.OPENVIKING_RECALL_TIMEOUT_MS = "1500";
    assert.match(context(await run("auto-recall.mjs", recallInput)), /local unique memory/);
  }, { teamBehavior: "stall" });
});

test("invalid routing configuration never contacts the secondary source", async () => {
  await fixture(async ({ local, team, run, routingPath, configs }) => {
    await writeFile(routingPath, JSON.stringify({ mode: "combined", sources: { local: configs.local, team: "relative.ovcli.conf" } }));
    assert.equal(context(await run("auto-recall.mjs", recallInput)), "");
    assert.equal(context(await run("session-start-commit.mjs", startupInput)), "");
    assert.equal(team.requests.length, 0);
    assert.ok(local.requests.every((r) => r.path === "/health"));
  });
});


test("directory overrides control both recall and startup profile without changing write identity", async () => {
  await fixture(async ({ home, local, team, run, routingPath, configs }) => {
    await writeFile(routingPath, JSON.stringify({ mode: "combined", sources: configs,
      directories: { [home]: "separate" } }));
    assert.match(context(await run("auto-recall.mjs", recallInput)), /local unique memory/);
    assert.match(context(await run("session-start-commit.mjs", startupInput)), /local unique profile/);
    assert.equal(team.requests.length, 0);
    await writeFile(routingPath, JSON.stringify({ mode: "separate", sources: configs,
      directories: { [home]: "combined" } }));
    const recalled = context(await run("auto-recall.mjs", recallInput));
    const started = context(await run("session-start-commit.mjs", startupInput));
    assert.match(recalled, /local unique memory/); assert.match(recalled, /team unique memory/);
    assert.match(started, /local unique profile/); assert.match(started, /team unique profile/);
    assert.ok(team.requests.every((r) => !r.path.includes("/sessions/")));
    assertIdentities(local, "local"); assertIdentities(team, "team");
  });
});
