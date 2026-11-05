#!/usr/bin/env node
// Community modification (2026-11-05): project routing and configurable multi-library reads.

/**
 * stdio -> streamable-HTTP MCP proxy for the OpenViking Codex plugin.
 *
 * Codex starts this process as a local stdio MCP server. The proxy reads the
 * same OpenViking credential sources as the lifecycle hooks, forwards JSON-RPC
 * requests to the server's /mcp endpoint, and keeps stdout protocol-clean.
 */

import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../scripts/config.mjs";
import { loadReadRouting } from "../scripts/read-routing.mjs";
import { createCombinedReadProxy } from "./combined-read.mjs";
import { createLogger } from "../scripts/debug-log.mjs";
import {
  buildMcpProxyConfig,
  resolveMcpActorPeerId,
} from "../scripts/shared/mcp-proxy-config.mjs";
import { createOpenVikingMcpProxy } from "../scripts/shared/mcp-proxy-core.mjs";

export { createOpenVikingMcpProxy } from "../scripts/shared/mcp-proxy-core.mjs";

let connectionIdentity;
let readMode;
let currentReadPlan;

export function readProxyConfig() {
  const cfg = loadConfig();
  const plan = loadReadRouting(cfg);
  const peerId = resolveMcpActorPeerId(cfg);
  const identity = JSON.stringify([cfg.baseUrl, cfg.mcpUrl, cfg.apiKey, cfg.account, cfg.user,
    peerId, cfg.authMode, cfg.recallPeerScope, cfg.cliConfigPath, cfg.ovConfigPath]);
  if (connectionIdentity !== undefined && connectionIdentity !== identity) {
    throw new Error("OpenViking connection changed; restart Codex in a new conversation.");
  }
  if (readMode !== undefined && readMode !== plan.mode) {
    throw new Error("OpenViking read configuration changed; restart Codex in a new conversation.");
  }
  connectionIdentity = identity;
  readMode = plan.mode;
  currentReadPlan = plan;
  return buildMcpProxyConfig({
    ...cfg, peerId,
    credentialPath: cfg.configPath,
    watchedPaths: [cfg.cliConfigPath, cfg.ovConfigPath],
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  const initialConfig = readProxyConfig();
  const plan = currentReadPlan;
  if (plan.mode === "combined") {
    try {
      const proxy = await createCombinedReadProxy({ plan, readPrimaryConfig: readProxyConfig,
        readPlan: () => currentReadPlan, loggerFactory: createLogger });
      proxy.start();
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  } else {
    createOpenVikingMcpProxy({ readConfig: () => initialConfig, validateConfig: readProxyConfig,
      loggerFactory: createLogger }).start();
  }
}
