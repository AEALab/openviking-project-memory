import { closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReadStream, WriteStream } from "node:tty";
import { loadCredentialFiles, resolveOpenVikingCredentials } from "../codex-memory-plugin/scripts/shared/credentials.mjs";
import { runSetupWizard } from "../codex-memory-plugin/scripts/shared/setup-wizard.mjs";

const SETUP_COMMAND = "openviking-project-memory setup";

export function hasConnectionConfig(env = process.env) {
  const files = loadCredentialFiles(env);
  const credentials = resolveOpenVikingCredentials(env, files);
  const legacyPath = (env.OPENVIKING_CONFIG_FILE?.trim() || join(homedir(), ".openviking", "ov.conf"))
    .replace(/^~(?=\/|$)/, homedir());
  // Preserve existing files, including malformed ones, rather than replacing them during installation.
  return Boolean(files.cliPath || files.ovPath || existsSync(files.cliPathCandidate) || existsSync(legacyPath)
    || credentials.hasApiKey
    || (credentials.credentialSource !== "ovcli"
      && [env.OPENVIKING_URL, env.OPENVIKING_BASE_URL, env.OPENVIKING_MCP_URL]
        .some((value) => typeof value === "string" && value.trim())));
}

export function openSetupTerminal({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  if (env.CI && env.CI !== "false") return null;
  if (input.isTTY && output.isTTY) return { input, output, close() {} };
  if (process.platform === "win32") return null;

  // npm captures lifecycle stdio; the controlling terminal still reaches the person installing the package.
  let inputFd;
  let outputFd;
  try {
    inputFd = openSync("/dev/tty", "r");
    outputFd = openSync("/dev/tty", "w");
  } catch {
    if (inputFd !== undefined) closeSync(inputFd);
    return null;
  }
  const terminalInput = new ReadStream(inputFd);
  const terminalOutput = new WriteStream(outputFd);
  return {
    input: terminalInput,
    output: terminalOutput,
    close() { terminalInput.destroy(); terminalOutput.destroy(); },
  };
}

export async function setupAfterInstall({
  env = process.env,
  openTerminal = openSetupTerminal,
  wizard = runSetupWizard,
  output = process.stdout,
} = {}) {
  const terminal = openTerminal({ env });
  const say = (message) => (terminal?.output || output).write(message + "\n");
  try {
    say("OpenViking Project Memory: plugin and MCP registration completed.");
    if (hasConnectionConfig(env)) {
      say("Existing OpenViking configuration preserved. To review it, run " + SETUP_COMMAND + ".");
      say("Restart Codex and open a new chat to apply.");
      return;
    }
    if (!terminal) {
      say("No interactive terminal or running in CI. Configure your server later with: " + SETUP_COMMAND);
      return;
    }
    say("No OpenViking connection found. Starting setup; you can decline saving at the end.");
    const result = await wizard({ env, input: terminal.input, output: terminal.output });
    say(result.written
      ? "Connection saved. Restart Codex and open a new chat to apply."
      : "Connection not saved. Before using memory, run " + SETUP_COMMAND + ".");
  } catch {
    // Keep registration usable and avoid logging configuration values from setup errors.
    say("Connection setup did not finish. Retry with: " + SETUP_COMMAND);
  } finally { terminal?.close(); }
}
