// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadReadRouting, requestReadJSON, formatReadSource } from "./read-routing.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "ov-read-routing-"));
  const original = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (original === undefined) delete process.env.HOME; else process.env.HOME = original;
    rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".openviking"));
  const path = join(home, ".openviking", "read-routing.json");
  const local = join(home, "local.ovcli.conf"), team = join(home, "team.ovcli.conf");
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  const current = { baseUrl: "https://local.example", apiKey: "local-key", account: "local-account",
    user: "local-user", peerId: "primary-peer", sendIdentityHeaders: true, authMode: "trusted",
    timeoutMs: 200, workspacePeer: true, recallPeerScope: "actor", recallLimit: 7 };
  const localFile = { url: current.baseUrl + "/", api_key: current.apiKey,
    account_id: current.account, user_id: current.user };
  write(local, localFile); write(team, { url: "https://team.example", api_key: "team-key" });
  const route = (mode = "combined", sources = { local, team }) => write(path, { mode, sources });
  return { home, path, local, team, localFile, write, route, current };
}

test("missing/separate config preserves only current connection; combined rebuilds independent identities", (t) => {
  const f = fixture(t);
  assert.equal(loadReadRouting(f.current).sources[0].config, f.current);
  f.route("separate", { local: "/missing", team: null });
  assert.equal(loadReadRouting(f.current).sources.length, 1);
  f.route();
  const plan = loadReadRouting(f.current);
  assert.deepEqual(plan.sources.map((s) => [s.name, s.primary]), [["local", true], ["team", false]]);
  const cfg = plan.sources[1].config;
  assert.equal(cfg.apiKey, "team-key"); assert.equal(cfg.baseUrl, "https://team.example");
  assert.equal(cfg.account, ""); assert.equal(cfg.user, ""); assert.equal(cfg.peerId, "");
  assert.equal(cfg.sendIdentityHeaders, false); assert.equal(cfg.authMode, "api_key");
  assert.equal(cfg.workspacePeer, false); assert.equal(cfg.recallPeerScope, "all");
  assert.equal(cfg.recallLimit, 7);
  assert.deepEqual(plan.watchedPaths, [f.path, f.local, f.team]);
});

test("combined primary identity validation and duplicate aliases prevent extra or foreign reads", (t) => {
  const f = fixture(t); f.route();
  for (const field of ["baseUrl", "apiKey", "account", "user"]) {
    assert.throws(() => loadReadRouting({ ...f.current, [field]: "wrong" }), /Primary.*identity/);
  }
  f.write(f.team, f.localFile);
  const plan = loadReadRouting(f.current);
  assert.equal(plan.sources.length, 1); assert.deepEqual(plan.sources[0].names, ["local", "team"]);
});

test("directory modes match exact paths and descendants, exclude sibling prefixes, and prefer closest rules", (t) => {
  const f = fixture(t), project = join(f.home, "project-a"), nested = join(project, "nested");
  mkdirSync(nested, { recursive: true });
  f.write(f.path, { mode: "combined", sources: { local: f.local, team: f.team },
    directories: { [nested]: "combined", [project]: "separate" } });
  for (const cwd of [project, join(project, "src")]) {
    const plan = loadReadRouting(f.current, cwd);
    assert.equal(plan.mode, "separate");
    assert.equal(plan.sources[0].config, f.current);
    assert.deepEqual(plan.watchedPaths, [f.path]);
  }
  for (const cwd of [nested, join(nested, "src"), join(f.home, "project-a2"), f.home]) {
    assert.equal(loadReadRouting(f.current, cwd).mode, "combined");
  }
});

test("directory normalization handles aliases, missing descendants, spaces, Unicode, and home paths", (t) => {
  const f = fixture(t), projects = join(f.home, "项目 spaces"), alias = join(f.home, "alias");
  mkdirSync(projects);
  symlinkSync(projects, alias, "dir");
  const canonical = realpathSync(projects);
  for (const [directory, cwd] of [
    [alias, canonical],
    [join(alias, "missing", "..", "new project"), join(canonical, "new project", "src")],
    ["~/项目 spaces", join(alias, "missing")],
    [canonical, join(alias, "missing", "nested")],
  ]) {
    f.write(f.path, { mode: "combined", directories: { [directory]: "separate" } });
    assert.equal(loadReadRouting(f.current, cwd).mode, "separate");
  }
});

test("all directory overrides fail closed before separate returns or combined source parsing", (t) => {
  const f = fixture(t);
  for (const directories of [null, [], "separate", 1, { relative: "combined" },
    { [f.home]: "typo" }, { [f.home]: null },
    { [f.home]: "separate", [join(f.home, "unrelated")]: "typo" }]) {
    for (const mode of ["separate", "combined"]) {
      f.write(f.path, { mode, sources: null, directories });
      assert.throws(() => loadReadRouting(f.current, f.home), /Invalid.*routing director/);
    }
  }
  f.write(f.path, { mode: "typo", directories: { [f.home]: "separate" } });
  assert.throws(() => loadReadRouting(f.current, f.home), /Invalid.*routing/);
});

test("directory separate ignores broken source files and combined overrides preserve primary identity checks", (t) => {
  const f = fixture(t), project = join(f.home, "project");
  f.write(f.path, { mode: "separate", sources: { local: f.local, team: f.team },
    directories: { [project]: "combined" } });
  assert.equal(loadReadRouting(f.current, f.home).mode, "separate");
  assert.deepEqual(loadReadRouting(f.current, project).sources.map((source) => source.name), ["local", "team"]);
  assert.throws(() => loadReadRouting({ ...f.current, apiKey: "foreign" }, project), /Primary.*identity/);
  writeFileSync(f.team, "{");
  assert.throws(() => loadReadRouting(f.current, project), /Invalid.*source/);
  f.write(f.path, { mode: "combined", sources: { local: f.local, team: f.team },
    directories: { [project]: "separate" } });
  assert.equal(loadReadRouting(f.current, project).mode, "separate");
  assert.throws(() => loadReadRouting(f.current, f.home), /Invalid.*source/);
});

test("invalid mode, source config, URL, and missing credentials fail closed", (t) => {
  const f = fixture(t);
  for (const value of [null, [], {}, { mode: "typo" }, { mode: "combined", sources: {} },
    { mode: "combined", sources: { local: "relative", team: f.team } }]) {
    f.write(f.path, value); assert.throws(() => loadReadRouting(f.current));
  }
  f.route();
  for (const file of [{}, { url: "https://team.example", api_key: "" },
    { url: "file:///tmp/private", api_key: "k" }, { url: "https://user:secret@team.example", api_key: "k" },
    { url: "https://team.example?token=secret", api_key: "k" },
    { url: "https://team.example", api_key: "k", user: 123 }]) {
    f.write(f.team, file); assert.throws(() => loadReadRouting(f.current), /Invalid.*source/);
  }
  rmSync(f.team); assert.throws(() => loadReadRouting(f.current), /Invalid.*source/);
  writeFileSync(f.path, "{"); assert.throws(() => loadReadRouting(f.current), /Invalid.*routing/);
});

test("read request carries only source credentials, honors own peer, and rejects redirects", async (t) => {
  const f = fixture(t); f.route();
  const source = loadReadRouting(f.current).sources[1];
  let captured;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, json: async () => ({ result: { found: true } }) };
  });
  const result = await requestReadJSON(source, "/read", { headers: { Authorization: "foreign" }, redirect: "follow" });
  assert.equal(result.ok, true); assert.equal(captured.url, "https://team.example/read");
  assert.equal(captured.init.headers.Authorization, "Bearer team-key");
  assert.equal(captured.init.headers["X-OpenViking-User"], undefined);
  assert.equal(captured.init.headers["X-OpenViking-Actor-Peer"], undefined);
  assert.equal(captured.init.redirect, "error");
  await requestReadJSON(source, "/read", {}, { actorPeerId: "own-peer" });
  assert.equal(captured.init.headers["X-OpenViking-Actor-Peer"], "own-peer");
});

test("bad responses, offline, and source deadlines return bounded failures without credentials", async (t) => {
  const f = fixture(t), source = { config: f.current };
  t.mock.method(globalThis, "fetch", async () => ({ ok: false, status: 403, json: async () => ({ error: { message: "denied" } }) }));
  assert.equal((await requestReadJSON(source, "/read")).status, 403);
  globalThis.fetch = async () => { throw new Error("secret-key"); };
  const offline = await requestReadJSON(source, "/read");
  assert.equal(offline.status, 0); assert.ok(!JSON.stringify(offline).includes("secret-key"));
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
  const stalled = await requestReadJSON(source, "/read", {}, { timeoutMs: 10 });
  assert.equal(stalled.status, 0); assert.match(stalled.error.message, /timed out/);
});

test("read source marker preserves provenance and detail-read selector", () => {
  const marked = formatReadSource("team", "same URI, different source");
  assert.match(marked, /<openviking-read-source name="team">/);
  assert.match(marked, /_ov_source="team"/);
  assert.match(marked, /same URI, different source/);
});


test("primary keeps its explicit MCP endpoint and secondary retains common actor scope", (t) => {
  const f = fixture(t); f.route();
  f.current.mcpUrl = "https://primary-gateway.example/custom-mcp";
  let plan = loadReadRouting(f.current);
  assert.equal(plan.sources[0].config.mcpUrl, f.current.mcpUrl);
  f.write(f.team, { url: "https://team.example", api_key: "team-key", actor_peer_id: "team-own-peer",
    plugin: { recallPeerScope: "actor" } });
  plan = loadReadRouting(f.current);
  assert.equal(plan.sources[1].config.recallPeerScope, "actor");
  assert.equal(plan.sources[1].config.peerId, "team-own-peer");
  f.write(f.team, { url: "https://team.example", api_key: "team-key", plugin: { recallPeerScope: "actor" } });
  assert.throws(() => loadReadRouting(f.current), /requires its own peer/);
});
