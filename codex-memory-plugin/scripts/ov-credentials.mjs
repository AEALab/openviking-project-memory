// Community modification (2026-11-05): project routing and configurable multi-library reads.
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadCredentialFiles as loadSharedFiles,
  resolveOpenVikingCredentials as resolveSharedCredentials,
} from "./shared/credentials.mjs";

import { resolveProjectConfig } from "./project-config.mjs";

export function loadCredentialFiles(env = process.env) {
  const project = resolveProjectConfig(env);
  return loadSharedFiles(project.env, project.cliFile);
}

export function resolveOpenVikingCredentials(env = process.env) {
  const project = resolveProjectConfig(env);
  const files = loadSharedFiles(project.env, project.cliFile);
  return resolveSharedCredentials(project.env, files);
}

function main() {
  const cmd = process.argv[2] || "";
  if (cmd === "mcp-url") {
    process.stdout.write(resolveOpenVikingCredentials().mcpUrl);
    return;
  }
  if (cmd === "has-api-key") {
    process.stdout.write(resolveOpenVikingCredentials().hasApiKey ? "1" : "0");
    return;
  }
  if (cmd === "has-peer-id") {
    process.stdout.write(resolveOpenVikingCredentials().peerId ? "1" : "0");
    return;
  }
  process.stderr.write("usage: ov-credentials.mjs <mcp-url|has-api-key|has-peer-id>\n");
  process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1])) {
  main();
}
