// Community modification (2026-11-05): project routing and configurable multi-library reads.
import { createOpenVikingMcpProxy } from "../scripts/shared/mcp-proxy-core.mjs";
import { buildMcpProxyConfig, resolveMcpActorPeerId } from "../scripts/shared/mcp-proxy-config.mjs";
import { formatReadSource, normalizeConnectionUrl, readIdentity } from "../scripts/read-routing.mjs";

const READ_TOOLS = new Set(["find", "search", "read", "list", "tree", "grep", "glob", "health"]);
const PROTOCOL = "2025-06-18";
const silentLogger = () => ({ log() {}, logError() {} });

function sourceProxyConfig(source) {
  const cfg = source.config;
  return buildMcpProxyConfig({
    ...cfg, account: cfg.sendIdentityHeaders ? cfg.account : "",
    user: cfg.sendIdentityHeaders ? cfg.user : "", peerId: resolveMcpActorPeerId(cfg),
    mcpUrl: cfg.mcpUrl || cfg.baseUrl + "/mcp", watchedPaths: [], env: {},
  });
}

// Reuse the existing HTTP transport, protocol negotiation and session recovery.
function sourceClient(source, fetchImpl) {
  let sequence = 0;
  let ready;
  const responses = new Map();
  const proxy = createOpenVikingMcpProxy({
    readConfig: () => sourceProxyConfig(source), loggerFactory: silentLogger,
    fetchImpl,
    stdout: { write(line, callback) {
      const response = JSON.parse(line);
      responses.set(response.id, response);
      callback?.();
      return true;
    } },
  });
  async function rpc(method, params = {}) {
    const id = ++sequence;
    await proxy.handleMessage({ jsonrpc: "2.0", id, method, params });
    const response = responses.get(id);
    responses.delete(id);
    if (!response || response.error) throw new Error("OpenViking source request failed");
    return response.result;
  }
  async function initialize() {
    if (!ready) ready = (async () => {
      await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {},
        clientInfo: { name: "openviking-combined-reader", version: "1" } });
      await proxy.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((error) => { ready = undefined; throw error; });
    return ready;
  }
  return {
    async tools() { await initialize(); return (await rpc("tools/list")).tools || []; },
    async call(name, args) { await initialize(); return rpc("tools/call", { name, arguments: args }); },
    close: () => proxy.closeSession(),
  };
}

function planIdentity(plan) {
  return JSON.stringify([plan.mode, plan.sources.map((s) => [s.name, s.names, s.primary,
    readIdentity(s.config), normalizeConnectionUrl(s.config.mcpUrl), s.config.peerId, s.config.authMode, s.config.recallPeerScope])]);
}

function resultText(result) {
  const text = result?.content?.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  if (text) return text;
  if (Array.isArray(result?.content) && result.content.length) return "See the attached non-text content from this source.";
  return JSON.stringify(result?.structuredContent ?? result);
}

export async function createCombinedReadProxy({
  plan, readPrimaryConfig, readPlan, loggerFactory = silentLogger,
  fetchImpl = globalThis.fetch, stdin = process.stdin, stdout = process.stdout,
}) {
  const primary = plan.sources.find((s) => s.primary);
  if (!primary) throw new Error("Combined reads require a primary write connection");
  const identity = planIdentity(plan);
  const clients = new Map(plan.sources.map((s) => [s, sourceClient(s, fetchImpl)]));
  const inventories = new Map();
  const unavailable = new Set(plan.sources);
  let inventoryRefresh;
  let tools = new Map();
  const names = [...new Set(plan.sources.flatMap((s) => s.names || [s.name]))];
  function rebuildTools() {
    tools = new Map();
    for (const tool of inventories.get(primary) || []) tools.set(tool.name, structuredClone(tool));
    for (const source of plan.sources) {
      for (const tool of inventories.get(source) || []) {
        if (READ_TOOLS.has(tool.name) && !tools.has(tool.name)) tools.set(tool.name, structuredClone(tool));
      }
    }
    for (const tool of tools.values()) {
      if (!READ_TOOLS.has(tool.name)) continue;
      // Combined reads wrap source results, so the source output schema no longer applies.
      delete tool.outputSchema;
      tool.description = (tool.description || tool.name) + " Reads both libraries by default; use _ov_source for a source-specific read.";
      tool.inputSchema ||= { type: "object", properties: {} };
      tool.inputSchema.properties ||= {};
      tool.inputSchema.properties._ov_source = {
        type: "string", enum: ["all", "current", ...names], default: "all",
        description: "Read source. current is this project's write connection.",
      };
      // Search can update source-local query/session bookkeeping, so do not call it idempotent.
      tool.annotations = { ...tool.annotations, readOnlyHint: tool.name !== "search", destructiveHint: false };
    }
  }
  async function refreshUnavailableTools() {
    if (inventoryRefresh) return inventoryRefresh;
    if (unavailable.size === 0) return;
    inventoryRefresh = Promise.all([...unavailable].map(async (source) => {
      try {
        inventories.set(source, await clients.get(source).tools());
        unavailable.delete(source);
      } catch { /* retry unavailable inventories on the next tools/list */ }
    })).then(rebuildTools).finally(() => { inventoryRefresh = undefined; });
    return inventoryRefresh;
  }
  await refreshUnavailableTools();
  if (tools.size === 0) {
    await Promise.allSettled([...clients.values()].map((client) => client.close()));
    throw new Error("No OpenViking read source is reachable");
  }
  function assertConnections() {
    readPrimaryConfig();
    if (planIdentity(readPlan()) !== identity) throw new Error("OpenViking read configuration changed; restart Codex in a new conversation.");
  }
  const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });
  const provider = {
    listTools: () => [...tools.values()],
    async callTool({ name, arguments: args = {} }) {
      if (!args || typeof args !== "object" || Array.isArray(args)) return failure("Tool arguments must be an object");
      const { _ov_source: selector = "all", ...input } = args;
      if (!READ_TOOLS.has(name)) {
        if (selector !== "all" && selector !== "current") return failure("Writes are restricted to the current project's connection");
        // No write is ever sent to a secondary source, including unknown future tools.
        return clients.get(primary).call(name, input);
      }
      if (!["all", "current", ...names].includes(selector)) return failure("Unknown OpenViking read source");
      let selected = selector === "all" ? plan.sources : selector === "current" ? [primary]
        : plan.sources.filter((s) => (s.names || [s.name]).includes(selector));
      // Session archive references belong to the current conversation unless a source is explicit.
      if (selector === "all" && [input.uri, input.target_uri, ...(Array.isArray(input.uris) ? input.uris : [])]
        .some((uri) => typeof uri === "string" && /^viking:\/\/[^\s"]*\/sessions\//.test(uri))) selected = [primary];
      const results = await Promise.all(selected.map(async (source) => {
        const sourceInput = { ...input };
        if (!source.primary) {
          for (const key of ["session_id", "peer_id", "actor_peer_id", "account", "account_id", "user", "user_id"]) delete sourceInput[key];
          if (sourceInput.peer_scope === "actor" && !source.config.peerId) return {
            source: source.name, ok: false,
            result: failure("Actor-scoped reads require a configured peerId for this source."),
          };
        }
        try {
          const result = await clients.get(source).call(name, sourceInput);
          return { source: source.name, ok: result?.isError !== true, result };
        } catch { return { source: source.name, ok: false }; }
      }));
      return {
        isError: results.every((r) => !r.ok),
        content: results.flatMap((r) => [
          { type: "text", text: formatReadSource(r.source,
            r.result ? resultText(r.result) : "This source is unavailable; other source results remain usable.") },
          ...(r.result?.content || []).filter((part) => part.type !== "text"),
        ]),
        structuredContent: { sources: results },
        _meta: { openvikingRead: true },
      };
    },
  };
  async function facadeFetch(url, init) {
    if (init.method === "DELETE") {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
      return new Response(null, { status: 204 });
    }
    const message = JSON.parse(init.body);
    let result;
    if (message.method === "initialize") {
      result = { protocolVersion: PROTOCOL, capabilities: { tools: {} },
        serverInfo: { name: "openviking-combined-reader", version: "1" } };
    } else if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    else if (message.method === "tools/list") { await refreshUnavailableTools(); result = { tools: [] }; }
    else if (message.method === "ping") result = {};
    else return Response.json({ jsonrpc: "2.0", id: message.id,
      error: { code: -32601, message: "Unknown OpenViking method or tool" } });
    return Response.json({ jsonrpc: "2.0", id: message.id, result },
      { headers: { "Mcp-Session-Id": "openviking-combined-reader" } });
  }
  return createOpenVikingMcpProxy({ stdin, stdout, readConfig: readPrimaryConfig, validateConfig: assertConnections,
    loggerFactory, localToolProvider: provider, fetchImpl: facadeFetch });
}
