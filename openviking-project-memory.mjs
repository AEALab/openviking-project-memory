#!/usr/bin/env node
import { install } from "./scripts/install.mjs";

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "install") install();
  else if (args.length === 1 && args[0] === "setup") {
    const { runSetupWizard } = await import("./codex-memory-plugin/scripts/shared/setup-wizard.mjs");
    await runSetupWizard();
  } else if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    console.log("Usage: openviking-project-memory install  Register the Codex plugin and configure MCP\n       openviking-project-memory setup    Configure the OpenViking server connection\n       ov-memory status         Inspect memory read routing");
  } else throw new Error("Unknown command. Run openviking-project-memory --help.");
} catch (error) {
  console.error("OpenViking Project Memory: " + error.message);
  process.exitCode = 1;
}
