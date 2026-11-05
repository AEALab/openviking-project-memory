// Community modification (2026-11-05): project routing and configurable multi-library reads.
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createCombinedReadProxy } from "./combined-read.mjs";

const URI = "viking://~/memories/preferences/shared.md";
const READS = ["read", "find", "search", "list", "tree", "grep", "glob", "health"];
const WRITES = ["write", "remember", "forget", "set_acl", "admin_future_mutator"];

async function fixture(t, { primary = "local", offline = [], results = {}, endpoints = {}, sourceSchemas = {},
  peerIds = { local: "local-peer", team: "team-peer" } } = {}) {
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
        peerId: peerIds[name], authMode: "trusted", sendIdentityHeaders: true,
        recallPeerScope: peerIds[name] ? "actor" : "all", timeoutMs: 1000,
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
        ...sourceSchemas[name]?.[toolName],
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
  test(`wrapped reads omit source output schemas and ${primary} writes retain them`, async (t) => {
    const sourceSchemas = Object.fromEntries(["local", "team"].map((source) => [source,
      Object.fromEntries([...READS, ...WRITES].map((name) => [name, {
        inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        outputSchema: { type: "object", title: `${source} ${name} result`,
          properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false },
      }])),
    ]));
    const results = Object.fromEntries(["local", "team"].map((source) => [source, {
      content: [{ type: "text", text: `${source} result` }],
      structuredContent: { result: `${source} structured result` },
    }]));
    const h = await fixture(t, { primary, sourceSchemas, results });
    const inventory = (await h.rpc("tools/list")).result.tools;
    for (const name of READS) {
      const tool = inventory.find((tool) => tool.name === name);
      assert.equal(Object.hasOwn(tool, "outputSchema"), false, `${name} must not advertise the source's result shape`);
      const { _ov_source, ...properties } = tool.inputSchema.properties;
      assert.deepEqual({ ...tool.inputSchema, properties }, sourceSchemas[primary][name].inputSchema);
      assert.deepEqual(_ov_source.enum, ["all", "current", "local", "team"]);
      for (const selector of _ov_source.enum) {
        const result = await h.call(name, { query: "synthetic query", _ov_source: selector });
        assert.equal(result.isError, false);
        assert.equal(Object.hasOwn(result.structuredContent, "result"), false);
        const selected = selector === "all" ? ["local", "team"] : [selector === "current" ? primary : selector];
        assert.deepEqual(result.structuredContent.sources, selected.map((source) => ({ source, ok: true, result: results[source] })));
      }
    }
    for (const name of WRITES) {
      const tool = inventory.find((tool) => tool.name === name);
      assert.deepEqual(tool.inputSchema, sourceSchemas[primary][name].inputSchema);
      assert.deepEqual(tool.outputSchema, sourceSchemas[primary][name].outputSchema);
      assert.deepEqual(await h.call(name, { query: "synthetic write" }), results[primary]);
    }
  });

  test(`session URI routing uses only URI parameters when ${primary} is primary`, async (t) => {
    const h = await fixture(t, { primary });
    const archive = "viking://~/sessions/active-project-session/history/summary.md";
    const secondary = primary === "local" ? "team" : "local";
    for (const name of ["find", "search", "grep", "glob"]) {
      const args = { query: `explain ${archive}`, pattern: archive, exclude_uris: [archive], target_uri: "viking://~/memories" };
      const start = h.calls.length;
      const result = await h.call(name, args);
      assert.deepEqual(result.structuredContent.sources.map((source) => source.source), ["local", "team"]);
      assert.deepEqual(h.calls.slice(start).map((call) => call.body.params.arguments), [args, args]);
    }
    for (const [name, args] of [
      ["read", { uri: archive }], ["read", { uris: [URI, archive] }],
      ...["list", "tree", "grep", "glob"].map((name) => [name, { uri: archive }]),
      ...["search", "find"].map((name) => [name, { target_uri: archive }]),
    ]) {
      const start = h.calls.length;
      const result = await h.call(name, args);
      assert.deepEqual(result.structuredContent.sources.map((source) => source.source), [primary]);
      assert.deepEqual(h.calls.slice(start).map((call) => [call.name, call.body.params.arguments]), [[primary, args]]);
      const explicitStart = h.calls.length;
      const explicit = await h.call(name, { ...args, _ov_source: secondary });
      assert.deepEqual(explicit.structuredContent.sources.map((source) => source.source), [secondary]);
      assert.deepEqual(h.calls.slice(explicitStart).map((call) => [call.name, call.body.params.arguments]), [[secondary, args]]);
    }
  });

  test(`actor reads fail closed for a secondary without peerId when ${primary} is primary`, async (t) => {
    const h = await fixture(t, { primary, peerIds: { [primary]: `${primary}-peer` } });
    const secondary = primary === "local" ? "team" : "local";
    const args = { query: "synthetic preference", peer_scope: "actor", session_id: "active-project-session",
      peer_id: "foreign-peer", actor_peer_id: "foreign-actor" };
    for (const selector of ["all", secondary]) {
      const start = h.calls.length;
      const result = await h.call("search", { ...args, _ov_source: selector });
      assert.equal(result.isError, selector === secondary);
      const denied = result.structuredContent.sources.find((source) => source.source === secondary);
      assert.equal(denied.ok, false);
      assert.equal(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /Actor-scoped reads require a configured peerId/);
      assert.match(result.content.find((part) => part.text.includes(`name="${secondary}"`)).text, /configured peerId/);
      assert.deepEqual(h.calls.slice(start).map((call) => [call.name, call.body.params.arguments]),
        selector === "all" ? [[primary, args]] : []);
      if (selector === "all") {
        assert.equal(result.structuredContent.sources.find((source) => source.source === primary).ok, true);
        assert.ok(result.content.some((part) => part.text.includes(`${primary} distinct body`)));
      }
    }
    const start = h.calls.length;
    const unscoped = await h.call("search", { query: args.query, peer_scope: "all", _ov_source: secondary });
    assert.equal(unscoped.isError, false);
    assert.deepEqual(h.calls.slice(start).map((call) => [call.name, call.body.params.arguments]),
      [[secondary, { query: args.query, peer_scope: "all" }]]);
  });

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

test("equivalent source URLs keep combined MCP usable without relaxing endpoint path checks", async (t) => {
  const h = await fixture(t);
  const equivalent = structuredClone(h.plan);
  for (const source of equivalent.sources) {
    source.config.baseUrl = `HTTPS://${source.name.toUpperCase()}.EXAMPLE.TEST:443/`;
    source.config.mcpUrl = `HTTPS://${source.name.toUpperCase()}.EXAMPLE.TEST:443/mcp`;
  }
  h.setPlan(equivalent);
  assert.equal((await h.call("read", { uri: URI })).isError, false);
  assert.deepEqual(h.calls.filter((call) => call.body?.method === "tools/call").map((call) => call.name), ["local", "team"]);
  for (const suffix of ["/", "/different"]) {
    const changed = structuredClone(equivalent);
    changed.sources[0].config.mcpUrl += suffix;
    h.setPlan(changed);
    const before = h.calls.length;
    assert.ok((await h.rpc("tools/call", { name: "read", arguments: { uri: URI } })).error);
    assert.equal(h.calls.length, before);
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
