import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { mergeCodexConfig } from "./codex-config.mjs";

const PLUGIN_ID = "openviking-memory@openviking-project";
const ORIGINAL_PLUGIN_ID = "openviking-memory@openviking";
const options = {
  packageRoot: "/packages/OpenViking Project Memory",
  nodePath: "/tools/Node Runtime/bin/node",
  stateHome: "/users/A Hao/.openviking",
};

test("first installation enables hooks and independent MCP with paths containing spaces", () => {
  assert.deepEqual(mergeCodexConfig({}, options), {
    features: { hooks: true, plugin_hooks: true },
    plugins: {
      [PLUGIN_ID]: {
        enabled: true,
        mcp_servers: { "openviking-memory": { enabled: false } },
      },
    },
    mcp_servers: {
      "openviking-memory": {
        enabled: true,
        command: options.nodePath,
        args: [join(options.packageRoot, "codex-memory-plugin/servers/mcp-proxy.mjs")],
        startup_timeout_sec: 30,
      },
    },
    sandbox_workspace_write: {
      writable_roots: [join(options.stateHome, "codex-plugin-state"), join(options.stateHome, "logs")],
    },
  });
});

test("preserves unknown user fields, timeout and roots while disabling duplicate hooks", () => {
  const config = {
    model: "user-model",
    custom: { nested: ["retained"] },
    features: { hooks: false, other_feature: true },
    plugins: {
      unrelated: { enabled: true, custom: "plugin" },
      [ORIGINAL_PLUGIN_ID]: { enabled: true, custom: "original" },
      [PLUGIN_ID]: {
        custom: "project",
        mcp_servers: {
          other: { enabled: true },
          "openviking-memory": { enabled: true, custom: "bundled" },
        },
      },
    },
    mcp_servers: {
      other: { command: "other" },
      "openviking-memory": {
        command: "old-node", args: ["old-proxy"], cwd: "/old/project",
        startup_timeout_sec: 75, env: { CUSTOM: "retained" }, custom: "server",
      },
    },
    sandbox_workspace_write: {
      network_access: true,
      writable_roots: ["/existing", join(options.stateHome, "logs"), "/existing"],
    },
  };
  const result = mergeCodexConfig(config, options);
  assert.deepEqual(result, {
    ...config,
    features: { ...config.features, hooks: true, plugin_hooks: true },
    plugins: {
      ...config.plugins,
      [ORIGINAL_PLUGIN_ID]: { enabled: false, custom: "original" },
      [PLUGIN_ID]: {
        custom: "project", enabled: true,
        mcp_servers: {
          other: { enabled: true },
          "openviking-memory": { enabled: false, custom: "bundled" },
        },
      },
    },
    mcp_servers: {
      other: { command: "other" },
      "openviking-memory": {
        enabled: true, command: options.nodePath,
        args: [join(options.packageRoot, "codex-memory-plugin/servers/mcp-proxy.mjs")],
        startup_timeout_sec: 75, env: { CUSTOM: "retained" }, custom: "server",
      },
    },
    sandbox_workspace_write: {
      network_access: true,
      writable_roots: ["/existing", join(options.stateHome, "logs"), join(options.stateHome, "codex-plugin-state")],
    },
  });
});

test("converts HTTP MCP to stdio while preserving environment and unknown fields", () => {
  const config = {
    mcp_servers: {
      "openviking-memory": {
        url: "http://localhost:1933/mcp",
        bearer_token_env_var: "OPENVIKING_TOKEN",
        http_headers: { "X-Custom": "header" },
        env_http_headers: { Authorization: "AUTHORIZATION" },
        env: { CUSTOM: "retained" },
        custom: { retained: true },
      },
    },
  };
  const snapshot = structuredClone(config);
  const server = mergeCodexConfig(config, options).mcp_servers["openviking-memory"];
  assert.deepEqual(server, {
    enabled: true,
    command: options.nodePath,
    args: [join(options.packageRoot, "codex-memory-plugin/servers/mcp-proxy.mjs")],
    startup_timeout_sec: 30,
    env: { CUSTOM: "retained" },
    custom: { retained: true },
  });
  assert.deepEqual(config, snapshot);
});

for (const pluginEnabled of [true, false]) {
  for (const serverEnabled of [true, false, undefined]) {
    test(`reinstall restores plugin enabled=${pluginEnabled} and MCP enabled=${serverEnabled}`, () => {
      const previousConfig = {
        plugins: { [PLUGIN_ID]: { enabled: pluginEnabled } },
        mcp_servers: { "openviking-memory": serverEnabled === undefined ? {} : { enabled: serverEnabled } },
      };
      const config = {
        ...previousConfig,
        plugins: { [PLUGIN_ID]: { enabled: true } },
      };
      const result = mergeCodexConfig(config, { ...options, previousConfig });
      assert.equal(result.plugins[PLUGIN_ID].enabled, pluginEnabled);
      assert.equal(result.mcp_servers["openviking-memory"].enabled, serverEnabled ?? pluginEnabled);
      assert.equal(result.plugins[PLUGIN_ID].mcp_servers["openviking-memory"].enabled, false);
    });
  }
}

test("independent MCP explicit false survives without an existing plugin setting", () => {
  const result = mergeCodexConfig({ mcp_servers: { "openviking-memory": { enabled: false } } }, options);
  assert.equal(result.plugins[PLUGIN_ID].enabled, true);
  assert.equal(result.mcp_servers["openviking-memory"].enabled, false);
});

test("merge is idempotent and never mutates either input", () => {
  const previousConfig = { plugins: { [PLUGIN_ID]: { enabled: false } } };
  const config = {
    plugins: { [PLUGIN_ID]: { enabled: true } },
    mcp_servers: { "openviking-memory": { cwd: "/inherited-project", env: { CUSTOM: "value" } } },
    sandbox_workspace_write: { writable_roots: ["/existing"] },
  };
  const originalConfig = structuredClone(config);
  const originalPreviousConfig = structuredClone(previousConfig);
  function freeze(value) {
    for (const child of Object.values(value)) {
      if (child !== null && typeof child === "object") freeze(child);
    }
    return Object.freeze(value);
  }
  freeze(config);
  freeze(previousConfig);
  const result = mergeCodexConfig(config, { ...options, previousConfig });
  assert.notEqual(result, config);
  assert.deepEqual(config, originalConfig);
  assert.deepEqual(previousConfig, originalPreviousConfig);
  assert.deepEqual(mergeCodexConfig(result, options), result);
});

const tablePaths = [
  [], ["features"], ["plugins"], ["plugins", PLUGIN_ID],
  ["plugins", PLUGIN_ID, "mcp_servers"],
  ["plugins", PLUGIN_ID, "mcp_servers", "openviking-memory"],
  ["plugins", ORIGINAL_PLUGIN_ID], ["mcp_servers"],
  ["mcp_servers", "openviking-memory"], ["sandbox_workspace_write"],
];

function atPath(path, value) {
  return path.reduceRight((child, key) => ({ [key]: child }), value);
}

test("rejects invalid current and previous tables without silently replacing data", () => {
  for (const path of tablePaths) {
    for (const value of [null, [], new Date(), "invalid", 7, true]) {
      const config = atPath(path, value);
      for (const input of ["config", "previousConfig"]) {
        const invoke = input === "config"
          ? () => mergeCodexConfig(config, options)
          : () => mergeCodexConfig({}, { ...options, previousConfig: config });
        assert.throws(invoke, {
          name: "TypeError",
          message: `${[input, ...path].join(".")} must be a plain object (TOML table)`,
        });
      }
    }
  }
});

test("accepts plain objects with a null prototype", () => {
  const config = Object.assign(Object.create(null), {
    features: Object.assign(Object.create(null), { custom_feature: true }),
  });
  assert.deepEqual(mergeCodexConfig(config, options).features, {
    custom_feature: true, hooks: true, plugin_hooks: true,
  });
});

test("rejects non-boolean enabled values in all touched plugin and server entries", () => {
  for (const path of [
    ["plugins", PLUGIN_ID], ["plugins", ORIGINAL_PLUGIN_ID],
    ["plugins", PLUGIN_ID, "mcp_servers", "openviking-memory"],
    ["mcp_servers", "openviking-memory"],
  ]) {
    for (const enabled of [null, undefined, "false", 0, [], {}]) {
      const config = atPath([...path, "enabled"], enabled);
      assert.throws(() => mergeCodexConfig(config, options), {
        name: "TypeError", message: `config.${path.join(".")}.enabled must be a boolean`,
      });
      assert.throws(() => mergeCodexConfig({}, { ...options, previousConfig: config }), {
        name: "TypeError", message: `previousConfig.${path.join(".")}.enabled must be a boolean`,
      });
    }
  }
});

test("rejects malformed writable roots in current or previous configuration", () => {
  for (const writable_roots of [null, undefined, "/a", {}, ["/a", 2], [null]]) {
    const config = { sandbox_workspace_write: { writable_roots } };
    assert.throws(() => mergeCodexConfig(config, options), /config\.sandbox_workspace_write\.writable_roots must be an array of strings/);
    assert.throws(() => mergeCodexConfig({}, { ...options, previousConfig: config }), /previousConfig\.sandbox_workspace_write\.writable_roots must be an array of strings/);
  }
});

test("requires the package, Node and state home paths", () => {
  for (const key of Object.keys(options)) {
    for (const value of [undefined, null, "", "   ", 7]) {
      assert.throws(() => mergeCodexConfig({}, { ...options, [key]: value }), {
        name: "TypeError", message: `${key} must be a non-empty string`,
      });
    }
  }
});
