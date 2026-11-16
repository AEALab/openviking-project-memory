import { join } from "node:path";

const PLUGIN_ID = "openviking-memory@openviking-project";
const ORIGINAL_PLUGIN_ID = "openviking-memory@openviking";
const SERVER_ID = "openviking-memory";

function assertTable(value, path) {
  if (value === null || typeof value !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${path} must be a plain object (TOML table)`);
  }
  return value;
}

function table(parent, key, path) {
  return Object.hasOwn(parent, key) ? assertTable(parent[key], path) : {};
}

function validateEnabled(value, path) {
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") {
    throw new TypeError(`${path}.enabled must be a boolean`);
  }
}

function inspectConfig(config, path) {
  assertTable(config, path);
  const features = table(config, "features", `${path}.features`);
  const plugins = table(config, "plugins", `${path}.plugins`);
  const plugin = table(plugins, PLUGIN_ID, `${path}.plugins.${PLUGIN_ID}`);
  const bundledServers = table(plugin, "mcp_servers", `${path}.plugins.${PLUGIN_ID}.mcp_servers`);
  const bundledServer = table(bundledServers, SERVER_ID, `${path}.plugins.${PLUGIN_ID}.mcp_servers.${SERVER_ID}`);
  const originalPlugin = table(plugins, ORIGINAL_PLUGIN_ID, `${path}.plugins.${ORIGINAL_PLUGIN_ID}`);
  const servers = table(config, "mcp_servers", `${path}.mcp_servers`);
  const server = table(servers, SERVER_ID, `${path}.mcp_servers.${SERVER_ID}`);
  const sandbox = table(config, "sandbox_workspace_write", `${path}.sandbox_workspace_write`);

  for (const [value, valuePath] of [
    [plugin, `${path}.plugins.${PLUGIN_ID}`],
    [bundledServer, `${path}.plugins.${PLUGIN_ID}.mcp_servers.${SERVER_ID}`],
    [originalPlugin, `${path}.plugins.${ORIGINAL_PLUGIN_ID}`],
    [server, `${path}.mcp_servers.${SERVER_ID}`],
  ]) validateEnabled(value, valuePath);

  if (Object.hasOwn(sandbox, "writable_roots")
    && (!Array.isArray(sandbox.writable_roots)
      || sandbox.writable_roots.some((root) => typeof root !== "string"))) {
    throw new TypeError(`${path}.sandbox_workspace_write.writable_roots must be an array of strings`);
  }
  return { features, plugins, plugin, bundledServers, bundledServer, originalPlugin, servers, server, sandbox };
}

export function mergeCodexConfig(config, { packageRoot, nodePath, stateHome, previousConfig = config }) {
  for (const [name, value] of Object.entries({ packageRoot, nodePath, stateHome })) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }
  const current = inspectConfig(config, "config");
  const previous = previousConfig === config ? current : inspectConfig(previousConfig, "previousConfig");
  const pluginEnabled = previous.plugin.enabled ?? false;
  const server = {
    ...current.server,
    enabled: previous.server.enabled ?? pluginEnabled,
    command: nodePath,
    args: [join(packageRoot, "codex-memory-plugin/servers/mcp-proxy.mjs")],
    startup_timeout_sec: Object.hasOwn(current.server, "startup_timeout_sec")
      ? current.server.startup_timeout_sec : 30,
  };
  for (const field of ["cwd", "url", "bearer_token_env_var", "http_headers", "env_http_headers"]) {
    delete server[field];
  }

  const plugins = {
    ...current.plugins,
    [PLUGIN_ID]: {
      ...current.plugin,
      enabled: pluginEnabled,
      mcp_servers: {
        ...current.bundledServers,
        [SERVER_ID]: { ...current.bundledServer, enabled: false },
      },
    },
  };
  if (Object.hasOwn(current.plugins, ORIGINAL_PLUGIN_ID)) {
    plugins[ORIGINAL_PLUGIN_ID] = { ...current.originalPlugin, enabled: false };
  }

  return {
    ...config,
    features: { ...current.features, hooks: true, plugin_hooks: true },
    plugins,
    mcp_servers: { ...current.servers, [SERVER_ID]: server },
    sandbox_workspace_write: {
      ...current.sandbox,
      writable_roots: [...new Set([
        ...(current.sandbox.writable_roots ?? []),
        join(stateHome, "codex-plugin-state"),
        join(stateHome, "logs"),
      ])],
    },
  };
}
