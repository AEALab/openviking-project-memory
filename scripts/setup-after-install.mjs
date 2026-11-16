import { closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReadStream, WriteStream } from "node:tty";
import { loadCredentialFiles, resolveOpenVikingCredentials } from "../codex-memory-plugin/scripts/shared/credentials.mjs";
import { runSetupWizard } from "./setup-wizard.mjs";

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
    say("OpenViking Project Memory：插件和独立 MCP 已完成注册。");
    if (hasConnectionConfig(env)) {
      say("已有连接配置已保留，安装过程不会自动修改全局默认或项目规则。");
      say("需要设置全局默认、项目选库或读取方式时，请运行：" + SETUP_COMMAND);
      say("配置完成后，请重启 Codex 并新建聊天。");
      return;
    }
    if (!terminal) {
      say("当前没有交互终端或正在 CI 中运行，已跳过配置向导。");
      say("新安装的插件和独立 MCP 默认保持关闭；稍后请运行：" + SETUP_COMMAND);
      return;
    }
    say("尚未发现 OpenViking 连接，即将进入配置向导；最后确认保存前不会写入配置。");
    const result = await wizard({ env, input: terminal.input, output: terminal.output });
    say(result.written
      ? "配置已保存。请重启 Codex 并新建聊天，使配置生效。"
      : "本次配置未保存。已完成的注册会保留；新安装的插件和独立 MCP 默认保持关闭。稍后请运行：" + SETUP_COMMAND);
  } catch {
    // Keep registration usable and avoid logging configuration values from setup errors.
    say("配置向导未完成，本次配置未保存。已完成的注册会保留；新安装的插件和独立 MCP 默认保持关闭。请重试：" + SETUP_COMMAND);
  } finally { terminal?.close(); }
}
