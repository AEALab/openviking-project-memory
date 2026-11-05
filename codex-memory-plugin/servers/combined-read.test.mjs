// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCombinedReadProxy } from "./combined-read.mjs";

const URI = "viking://~/memories/preferences/shared.md";
const READS = ["read", "find", "search"];
const WRITES = ["write", "remember", "forget", "set_acl", "admin_future_mutator"];

async function fixture(t, { primary = "local", offline = [], results = {}, endpoints = {} } = {}) {
  const calls = [];
  const stalled = new Set();
  const unavailable = new Set(offline);
  const plan = {
    mode: "combined",
    sources: ["local", "team"].map((name) => ({
      name, primary: name === primary,
      config: {
        baseUrl: `https://${name}.example.test`, mcpUrl: endpoints[name] || `https://${name}.example.test/mcp`,
        apiKey: `synthetic-${name}-key`, account: `${name}-account`, user: `${name}-user`,
        peerId: `${name}-peer`, authMode: "trusted", sendIdentityHeaders: true,
        recallPeerScope: "actor", timeoutMs: 1000,
      },
    })),
  };
  let nextPlan = plan;
  const messages = new Map();
  const fetchImpl = async (url, init) => {
    const name = new URL(url).hostname.split(".")[0];
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    const request = { name, url, method: init.method, headers, body, signal: init.signal, redirect: init.redirect };
    calls.push(request);
    assert.equal(url, endpoints[name] || `https://${name}.example.test/mcp`);
    assert.equal(headers.get("authorization"), `Bearer synthetic-${name}-key`);
    if (unavailable.has(name)) throw new Error("synthetic source offline");
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (body.method === "initialize") {
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name, version: "1" } };
    } else if (body.method === "tools/list") {
      result = { tools: [...READS, ...WRITES, `admin_${name}`].map((toolName) => ({
        name: toolName, description: toolName, inputSchema: { type: "object", properties: {} },
      })) };
    } else if (body.method === "tools/call") {
      if (stalled.has(name)) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        });
      }
      result = results[name] || { content: [{ type: "text", text: `${name} distinct body at ${URI}` }] };
    } else throw new Error(`unexpected mock method ${body.method}`);
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, {
      headers: body.method === "initialize" ? { "Mcp-Session-Id": `${name}-session` } : {},
    });
  };
  const primaryConfig = plan.sources.find((source) => source.primary).config;
  const proxy = await createCombinedReadProxy({
    plan, readPlan: () => nextPlan,
    readPrimaryConfig: () => ({ ...primaryConfig, watchedPaths: [] }),
    fetchImpl, stdin: new PassThrough(),
    stdout: { write(line, callback) {
      const message = JSON.parse(line);
      messages.set(message.id, message);
      callback?.();
      return true;
    } },
  });
  t.after(() => proxy.closeSession());
  let id = 0;
  async function rpc(method, params) {
    const requestId = ++id;
    await proxy.handleMessage({ jsonrpc: "2.0", id: requestId, method, params });
    const response = messages.get(requestId);
    assert.ok(response, "proxy must complete each JSON-RPC request");
    messages.delete(requestId);
    return response;
  }
  async function call(name, args = {}) {
    const response = await rpc("tools/call", { name, arguments: args });
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.result;
  }
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.serverInfo.name, "openviking-combined-reader");
  calls.length = 0;
  return { plan, proxy, rpc, call, calls, stalled, unavailable, setPlan(value) { nextPlan = value; } };
}

function assertSourceIdentities(calls) {
  for (const { name, headers, body, redirect } of calls) {
    assert.equal(headers.get("authorization"), `Bearer synthetic-${name}-key`);
    assert.equal(headers.get("x-openviking-account"), `${name}-account`);
    assert.equal(headers.get("x-openviking-user"), `${name}-user`);
    assert.equal(headers.get("x-openviking-actor-peer"), `${name}-peer`);
    if (body?.method !== "initialize") assert.equal(headers.get("mcp-session-id"), `${name}-session`);
    assert.equal(redirect, "error");
  }
}

for (const primary of ["local", "team"]) {
  test(`combined MCP reads both sources and writes only ${primary} when it is primary`, async (t) => {
    const h = await fixture(t, { primary });
    const secondary = primary === "local" ? "team" : "local";
    const inventory = (await h.rpc("tools/list")).result.tools;
    assert.ok(inventory.some((tool) => tool.name === `admin_${primary}`));
    assert.ok(!inventory.some((tool) => tool.name === `admin_${secondary}`));
    assert.deepEqual(inventory.find((tool) => tool.name === "read").inputSchema.properties._ov_source.enum, ["all", "current", "local", "team"]);
    assert.equal(inventory.find((tool) => tool.name === "read").annotations.readOnlyHint, true);
    assert.equal(inventory.find((tool) => tool.name === "search").annotations.readOnlyHint, false);
    for (const name of READS) {
      const start = h.calls.length;
      const result = await h.call(name, { uri: URI, query: "synthetic preference" });
      assert.equal(result.isError, false);
      assert.deepEqual(result.structuredContent.sources.map((source) => [source.source, source.ok]), [["local", true], ["team", true]]);
      for (const source of ["local", "team"]) {
        assert.ok(result.content.some((part) => part.text.includes(`name="${source}"`) && part.text.includes(`${source} distinct body at ${URI}`)));
      }
      assert.deepEqual(h.calls.slice(start).map((call) => call.name).sort(), ["local", "team"]);
    }
    for (const selector of ["local", "team", "current"]) {
      const start = h.calls.length;
      const result = await h.call("read", { uri: URI, _ov_source: selector });
      const expected = selector === "current" ? primary : selector;
      assert.deepEqual(result.structuredContent.sources.map((source) => source.source), [expected]);
      assert.deepEqual(h.calls.slice(start).map((call) => call.name), [expected]);
      assert.equal(Object.hasOwn(h.calls.at(-1).body.params.arguments, "_ov_source"), false);
    }
    const identityArgs = {
      query: "synthetic preference", session_id: "active-project-session", peer_id: "foreign-peer",
      actor_peer_id: "foreign-actor", account: "foreign-account", account_id: "foreign-account-id",
      user: "foreign-user", user_id: "foreign-user-id", peer_scope: "actor",
    };
    const start = h.calls.length;
    await h.call("search", identityArgs);
    const routed = h.calls.slice(start);
    assert.deepEqual(routed.find((call) => call.name === primary).body.params.arguments, identityArgs);
    assert.deepEqual(routed.find((call) => call.name === secondary).body.params.arguments, {
      query: identityArgs.query, peer_scope: "actor",
    });
    const archiveStart = h.calls.length;
    await h.call("read", { uri: "viking://~/sessions/active-project-session/history/summary.md" });
    assert.deepEqual(h.calls.slice(archiveStart).map((call) => call.name), [primary]);
    for (const name of [...WRITES, `admin_${primary}`]) {
      const writeStart = h.calls.length;
      const result = await h.call(name, { value: "synthetic write" });
      assert.match(result.content[0].text, new RegExp(`${primary} distinct body`));
      assert.deepEqual(h.calls.slice(writeStart).map((call) => [call.name, call.body.params.name]), [[primary, name]]);
      const deniedStart = h.calls.length;
      const denied = await h.call(name, { _ov_source: secondary, value: "synthetic denied write" });
      assert.equal(denied.isError, true);
      assert.match(denied.content[0].text, /restricted to the current project's connection/);
      assert.equal(h.calls.length, deniedStart);
    }
    const invalidStart = h.calls.length;
    assert.equal((await h.call("read", { _ov_source: "unknown-source", uri: URI })).isError, true);
    assert.equal(h.calls.length, invalidStart);
    await h.proxy.closeSession();
    const deletions = h.calls.filter((call) => call.method === "DELETE");
    assert.deepEqual(deletions.map((call) => call.name).sort(), ["local", "team"]);
    assertSourceIdentities(h.calls);
  });
}

for (const offline of ["local", "team"]) {
  test(`combined MCP preserves the other library when ${offline} is unavailable`, async (t) => {
    const h = await fixture(t, { offline: [offline] });
    const result = await h.call("read", { uri: URI });
    const reachable = offline === "local" ? "team" : "local";
    assert.equal(result.isError, false);
    assert.deepEqual(result.structuredContent.sources.map((source) => [source.source, source.ok]), [
      ["local", offline !== "local"], ["team", offline !== "team"],
    ]);
    assert.ok(result.content.some((part) => part.text.includes(`${reachable} distinct body`)));
    assert.ok(result.content.some((part) => part.text.includes("This source is unavailable")));
    assert.ok(h.calls.some((call) => call.name === reachable && call.body?.method === "tools/call"));
  });
}

test("a timed-out source aborts without discarding the other library's results", { timeout: 5000 }, async (t) => {
  const h = await fixture(t);
  h.stalled.add("team");
  const result = await h.call("find", { query: "synthetic preference" });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.sources.map((source) => [source.source, source.ok]), [["local", true], ["team", false]]);
  assert.equal(h.calls.find((call) => call.name === "team").signal.aborted, true);
});

test("changing read mode or a source requires restart before any source request", async (t) => {
  const h = await fixture(t);
  const separate = { ...h.plan, mode: "separate" };
  const changedSource = structuredClone(h.plan);
  changedSource.sources[1].config.apiKey = "synthetic-rotated-team-key";
  for (const next of [separate, changedSource]) {
    h.setPlan(next);
    for (const [method, params] of [
      ["tools/list", {}], ["tools/call", { name: "read", arguments: { uri: URI } }],
      ["tools/call", { name: "write", arguments: { value: "synthetic write" } }],
    ]) {
      const start = h.calls.length;
      const response = await h.rpc(method, params);
      assert.ok(response.error);
      assert.match(JSON.stringify(response.error), /configuration changed; restart Codex/);
      assert.equal(h.calls.length, start);
    }
  }
});

const IMAGE = {
  type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
};

test("image-only reads retain native images after each source label", async (t) => {
  const teamImage = { ...IMAGE, annotations: { audience: ["user"], priority: 0.5 } };
  const results = { local: { content: [IMAGE] }, team: { content: [teamImage] } };
  const h = await fixture(t, { results });
  const result = await h.call("read", { uri: URI });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.map((part) => part.type), ["text", "image", "text", "image"]);
  for (const [index, name] of [[0, "local"], [2, "team"]]) {
    assert.match(result.content[index].text, new RegExp(`name="${name}"`));
    assert.match(result.content[index].text, /attached non-text content/);
    assert.ok(!result.content[index].text.includes(IMAGE.data));
    assert.deepEqual(result.content[index + 1], results[name].content[0]);
  }
});

test("mixed reads keep text source labels and every native image, audio, and resource block", async (t) => {
  const audio = { type: "audio", mimeType: "audio/wav", data: "UklGRg==" };
  const resource = { type: "resource", resource: { uri: URI, mimeType: "text/plain", text: "team attached resource" } };
  const results = {
    local: { content: [{ type: "text", text: "local media summary" }, IMAGE, audio] },
    team: { content: [{ type: "text", text: "team media summary" }, resource] },
  };
  const h = await fixture(t, { results });
  const result = await h.call("read", { uri: URI });
  assert.equal(result.isError, false);
  assert.deepEqual(result.content.map((part) => part.type), ["text", "image", "audio", "text", "resource"]);
  assert.match(result.content[0].text, /name="local"[\s\S]*local media summary/);
  assert.match(result.content[3].text, /name="team"[\s\S]*team media summary/);
  assert.deepEqual(result.content.slice(1, 3), [IMAGE, audio]);
  assert.deepEqual(result.content[4], resource);
  for (const source of result.structuredContent.sources) assert.deepEqual(source.result, results[source.source]);
});


test("explicit primary MCP endpoint remains the write target and changing it requires restart", async (t) => {
  const endpoint = "https://local.example.test/custom-primary-mcp";
  const h = await fixture(t, { endpoints: { local: endpoint } });
  const before = h.calls.length;
  await h.call("write", { value: "synthetic write through custom gateway" });
  assert.deepEqual(h.calls.slice(before).map((r) => [r.name, r.url]), [["local", endpoint]]);
  const changed = structuredClone(h.plan);
  changed.sources[0].config.mcpUrl = "https://local.example.test/another-gateway";
  h.setPlan(changed);
  const count = h.calls.length;
  const response = await h.rpc("tools/call", { name: "write", arguments: { value: "must not send" } });
  assert.match(JSON.stringify(response.error), /configuration changed; restart Codex/);
  assert.equal(h.calls.length, count);
});

for (const primary of ["local", "team"]) {
  test(`tools/list discovers ${primary} writes after its startup outage without refreshing the healthy source`, async (t) => {
    const h = await fixture(t, { primary, offline: [primary] });
    const secondary = primary === "local" ? "team" : "local";
    const before = (await h.rpc("tools/list")).result.tools;
    assert.ok(before.some((tool) => tool.name === "read"));
    assert.ok(!before.some((tool) => WRITES.includes(tool.name)));
    const partial = await h.call("read", { uri: URI });
    assert.equal(partial.structuredContent.sources.find((source) => source.source === secondary).ok, true);
    assert.equal(h.calls.some((call) => call.body?.method === "tools/list" && call.name === secondary), false);
    h.unavailable.delete(primary);
    const refreshed = (await h.rpc("tools/list")).result.tools;
    assert.ok(refreshed.some((tool) => tool.name === `admin_${primary}`));
    assert.ok(!refreshed.some((tool) => tool.name === `admin_${secondary}`));
    assert.ok(WRITES.every((name) => refreshed.some((tool) => tool.name === name)));
    assert.deepEqual(h.calls.filter((call) => call.body?.method === "tools/list").map((call) => call.name), [primary]);
    const start = h.calls.length;
    await h.rpc("tools/list");
    assert.equal(h.calls.length, start, "healthy inventories stay cached");
    await h.call("admin_future_mutator", { value: "write after recovery" });
    assert.deepEqual(h.calls.slice(start).map((call) => [call.name, call.body?.params?.name]), [[primary, "admin_future_mutator"]]);
    const unknownStart = h.calls.length;
    const unknown = await h.rpc("tools/call", { name: "unknown_write", arguments: { value: "blocked" } });
    assert.ok(unknown.error);
    assert.equal(h.calls.length, unknownStart, "unknown tools never reach a secondary source");
  });
}
