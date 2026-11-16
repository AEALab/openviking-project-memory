// Community setup: plan every change before saving credentials, routing and enablement together.
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parse, stringify } from "smol-toml";
import { mergeCodexConfig } from "./codex-config.mjs";
import { canonicalDirectory, normalizeConnectionUrl, resolveReadMode, resolveReadRouting, sourceConfig } from "../codex-memory-plugin/scripts/read-routing.mjs";
import { resolveSharedConnection } from "../codex-memory-plugin/scripts/project-config.mjs";
import { updateRouting } from "../codex-memory-plugin/scripts/ov-memory.mjs";

const PLUGIN = "openviking-memory@openviking-project";
const SERVER = "openviking-memory";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const connectionOverride = (env = {}) => Object.entries(env).some(([key, value]) => value && /^OPENVIKING_(CLI_CONFIG_FILE|CONFIG_FILE|CREDENTIALS?_SOURCE|URL|BASE_URL|MCP_URL|API_KEY|BEARER_TOKEN|ACCOUNT|USER|PEER_ID|AUTH_MODE)$/.test(key));
function displayUrl(value) {
  try { const url = new URL(value); return url.origin + url.pathname; }
  catch { return "未配置或地址无效"; }
}

function regularBytes(path) {
  try {
    if (!lstatSync(path).isFile()) throw new Error("Configuration must be a regular file: " + path);
    return readFileSync(path);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Inspect the editable directories as well as files, so a project cannot redirect credential writes.
function safeParent(path) {
  let parent = dirname(path);
  while (true) {
    try {
      if (!lstatSync(parent).isDirectory()) throw new Error("Configuration parent must be a regular directory: " + parent);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (dirname(parent) === parent) return;
    parent = dirname(parent);
  }
}

function same(a, b) { return a === null ? b === null : b !== null && a.equals(b); }

function commit(files, locks, privateDirectories, backupRoot, verify) {
  const held = [];
  const saved = [];
  const modes = [];
  const backups = [];
  const suffix = Date.now() + "-" + randomUUID();
  const backupDirectory = join(backupRoot, suffix);
  const backupManifest = {};
  try {
    for (const path of locks) {
      safeParent(path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
      held.push(path);
    }
    for (const [path, file] of files) {
      safeParent(path);
      if (!same(regularBytes(path), file.before)) throw new Error("Configuration changed during setup; retry: " + path);
    }
    for (const path of privateDirectories) {
      safeParent(join(path, "probe"));
      const mode = existsSync(path) ? statSync(path).mode & 0o777 : null;
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (mode !== null && mode !== 0o700) { chmodSync(path, 0o700); modes.push([path, mode]); }
    }
    for (const [path, file] of files) {
      if (same(file.before, file.after) && (!file.write || file.after === null || (statSync(path).mode & 0o777) === 0o600)) continue;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (file.before !== null) {
        safeParent(join(backupDirectory, "probe"));
        mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
        const backup = join(backupDirectory, backups.length + "-" + basename(path));
        backupManifest[path] = backup;
        writeFileSync(join(backupDirectory, "manifest.json"), JSON.stringify(backupManifest, null, 2) + "\n", { mode: 0o600 });
        writeFileSync(backup, file.before, { flag: "wx", mode: 0o600 });
        backups.push(backup);
      }
      const temp = path + ".tmp-" + suffix;
      try {
        if (file.after !== null) writeFileSync(temp, file.after, { flag: "wx", mode: 0o600 });
        if (!same(regularBytes(path), file.before)) throw new Error("Configuration changed during setup; retry: " + path);
        if (file.after === null) rmSync(path);
        else renameSync(temp, path);
        saved.push([path, file]);
      } finally { rmSync(temp, { force: true }); }
    }
    verify();
    return { paths: saved.map(([path]) => path), backups: backupManifest };
  } catch (error) {
    let rollbackFailed = false;
    for (const [path, file] of saved.reverse()) {
      try {
        if (!same(regularBytes(path), file.after)) throw new Error();
        if (file.before === null) rmSync(path);
        else {
          const temp = path + ".restore-" + suffix;
          writeFileSync(temp, file.before, { flag: "wx", mode: 0o600 });
          renameSync(temp, path);
        }
      } catch { rollbackFailed = true; }
    }
    for (const [path, mode] of modes.reverse()) {
      try { chmodSync(path, mode); } catch { rollbackFailed = true; }
    }
    if (!rollbackFailed) for (const path of backups) {
      try { rmSync(path); } catch { rollbackFailed = true; }
    }
    throw new Error(rollbackFailed
      ? "Setup failed; some files could not be restored. Review backups in " + backupDirectory + " before starting Codex."
      : "Setup was not saved; prior file contents restored. " + (error.code === "EEXIST" ? "Another configuration writer holds a lock." : error.message));
  } finally { for (const path of held) rmSync(path, { force: true }); }
}

export async function runSetupWizard({
  input = process.stdin, output = process.stdout, env = process.env,
  home = homedir(), packageRoot = PACKAGE_ROOT, question,
} = {}) {
  home = realpathSync(home);
  const state = join(home, ".openviking");
  const globalPath = join(state, "ovcli.conf");
  const routingPath = join(state, "read-routing.json");
  const registryPath = join(state, "project-configs.json");
  const codexPath = join(resolve(env.CODEX_HOME || join(home, ".codex")), "config.toml");
  const files = new Map();
  const privateDirectories = new Set([state]);
  const snapshot = (path) => {
    safeParent(path);
    if (!files.has(path)) { const before = regularBytes(path); files.set(path, { before, after: before }); }
    return files.get(path);
  };
  const json = (path, fallback = {}) => {
    const bytes = snapshot(path).after;
    if (bytes === null) return fallback;
    try { const value = JSON.parse(bytes.toString()); if (!object(value)) throw new Error(); return value; }
    catch { throw new Error("Invalid JSON configuration; repair before setup: " + path); }
  };
  const toml = (path) => {
    try { return parse(snapshot(path).after?.toString() || ""); }
    catch { throw new Error("Invalid TOML configuration; repair before setup: " + path); }
  };
  const put = (path, value, format = (value) => JSON.stringify(value, null, 2)) => {
    const file = snapshot(path);
    file.after = Buffer.from(format(value) + "\n");
    file.write = true;
  };
  const say = (value = "") => output.write(value + "\n");
  let secret = false;
  const terminalOutput = new Writable({ write(chunk, encoding, done) { if (!secret) output.write(chunk, encoding); done(); } });
  terminalOutput.isTTY = output.isTTY;
  const rl = question ? null : createInterface({ input, output: terminalOutput, terminal: Boolean(input.isTTY && output.isTTY), historySize: 0 });
  const closed = new AbortController();
  rl?.on("close", () => closed.abort());
  const ask = async (prompt, hidden = false) => {
    say(prompt);
    secret = hidden;
    try { return String(await (question ? question(prompt, { secret: hidden }) : rl.question("", { signal: closed.signal }))).trim(); }
    finally { secret = false; if (hidden) say(); }
  };
  const choice = async (prompt, allowed, fallback) => {
    const menu = prompt.replace(/([：？])(?=[0-6] )/g, "$1\n  ").replaceAll("；", "\n  ");
    while (true) { const answer = (await ask(menu)) || fallback; if (allowed.includes(answer)) return answer; say("请选择列出的选项。"); }
  };
  const directory = (answer) => {
    const expanded = answer.startsWith("~/") ? join(home, answer.slice(2)) : answer;
    if (!isAbsolute(expanded)) throw new Error("项目/目录路径必须是绝对路径。");
    const path = realpathSync(expanded);
    if (!statSync(path).isDirectory() || path === dirname(path) || path === home || path === packageRoot) throw new Error("请指定实际项目目录，不能使用用户目录或 npm 包安装目录。");
    return path;
  };
  const connection = async (label, current) => {
    say(label + "连接：" + (current.url ? displayUrl(current.url) : "尚未配置服务地址") + "；Key " + (current.api_key ? "已保存" : "未设置") + "。");
    while (true) {
      const url = (await ask("服务 URL" + (current.url ? "（回车保留当前）" : "") + "：")) || current.url;
      try {
        const parsed = new URL(url);
        if (!/^https?:\/\//i.test(url) || !["https:", "http:"].includes(parsed.protocol)
          || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
        const api_key = (await ask(current.api_key ? "API Key（输入隐藏；回车保留已有 Key）：" : "API Key（必填；输入隐藏，不回显）：", true)) || current.api_key;
        if (typeof api_key !== "string" || !api_key.trim()) { say("需要有效的 API Key。"); continue; }
        const next = { ...current, url: url.replace(/\/+$/, ""), api_key };
        sourceConfig(label, "", {}, next);
        return next;
      } catch { say("连接格式无效：请使用无账号密码、查询参数或片段的 HTTP(S) URL，并检查身份配置。"); }
    }
  };
  const git = (project, args) => {
    const result = spawnSync("git", ["-C", project, ...args], { encoding: "utf8", timeout: 10000 });
    if (result.error || ![0, 1].includes(result.status)) throw new Error("无法检查项目 Git 忽略规则。");
    return result;
  };
  const ignoreCredentials = (project) => {
    const tracked = git(project, ["ls-files", "--", ".openviking"]);
    if (tracked.status !== 0 || tracked.stdout.trim()) throw new Error("项目 .openviking 已有被 Git 跟踪的文件；请先移除跟踪再配置凭据。");
    if ([".openviking/ovcli.conf", ".openviking/ovcli.conf.backup-probe"].every((path) => git(project, ["check-ignore", "-q", path]).status === 0)) return;
    const result = git(project, ["rev-parse", "--git-path", "info/exclude"]);
    if (result.status !== 0) throw new Error("项目连接覆盖需要 Git 工作区，以验证凭据被忽略。");
    const path = resolve(project, result.stdout.trim());
    const file = snapshot(path);
    file.after = Buffer.from((file.before?.toString() || "") + "\n.openviking/\n");
  };

  try {
    const current = json(globalPath);
    let routing = json(routingPath, { mode: "separate" });
    resolveReadMode(routing, home);
    const registry = json(registryPath);
    let codex = toml(codexPath);
    const roleName = (role) => ({ local: "个人库", team: "团队库", default: "跟随全局默认", inherit: "继承" }[role] || "原有连接");
    const readName = (mode) => mode === "combined" ? "一起读取（个人库 + 团队库）" : "分开读取（只读当前使用的库）";
    const flagName = (value) => value === undefined ? "未设置" : value ? "开启" : "关闭";
    const expandSource = (path) => typeof path === "string" && path.startsWith("~/") ? join(home, path.slice(2)) : path;
    const showRules = (title, rules, label) => {
      say(title);
      const entries = Object.entries(rules || {});
      if (!entries.length) say("  没有单独设置的目录，按上级目录规则或全局默认执行。");
      for (const [path, value] of entries) say("  " + path + " → " + label(value));
    };
    const oldSources = { ...routing.sources };
    let currentRole = routing.writeSource || Object.entries(oldSources).find(([, path]) => expandSource(path) === globalPath)?.[0];
    say("OpenViking 记忆配置向导");
    say("请先准备可用的 OpenViking 服务地址和 API Key。本向导设置库连接、全局默认和项目规则。");
    say("个人库和团队库按用途区分，都可以部署在本机、远程服务器或云端。");
    say("全局默认适用于没有单独设置的项目；项目可单独开启、关闭或选择库，子目录优先按最近的目录规则执行。");
    say("当前全局默认连接：" + displayUrl(current.url) + "；Key " + (current.api_key ? "已保存" : "未设置"));
    say("当前全局默认库：" + roleName(currentRole) + "；全局默认读取方式：" + readName(routing.mode));
    say("当前全局插件：" + flagName(codex.plugins?.[PLUGIN]?.enabled) + "；独立 MCP：" + flagName(codex.mcp_servers?.[SERVER]?.enabled));
    say("已有项目选库规则 " + Object.keys(routing.writeDirectories || {}).length + " 条，目录读取规则 " + Object.keys(routing.directories || {}).length + " 条。");
    const initialChoice = current.url ? "3" : "1";
    const action = await choice("这次要做什么？1 配置库连接、全局默认和项目规则；2 调整项目规则与全局启用状态（复用已保存的库）；3 保留当前配置并退出；0 取消并退出 [默认 " + initialChoice + "]：", ["0", "1", "2", "3"], initialChoice);
    if (["0", "3"].includes(action)) return { written: false };
    if (connectionOverride(env) || connectionOverride(codex.mcp_servers?.[SERVER]?.env)) {
      throw new Error("发现终端或 MCP 中有连接/身份环境变量覆盖。请先移除这些覆盖再配置，避免保存的方案与实际连接不一致。");
    }
    if (action === "2" && !current.url) throw new Error("还没有默认连接，请先选择“配置库连接、全局默认和项目规则”。");
    const full = action === "1";
    const values = {};
    const oldValues = {};
    for (const role of ["local", "team"]) {
      const path = expandSource(oldSources[role]);
      if (path) oldValues[role] = json(path);
    }
    if (currentRole) oldValues[currentRole] = current;
    let writeRole = currentRole;
    let all = Boolean(codex.plugins?.[PLUGIN]?.enabled && codex.mcp_servers?.[SERVER]?.enabled);
    let preserveScope = false;
    if (full) {
      say("第 1 步：配置库连接。选择两个库后，可在第 3 步选择分开读取或一起读取。");
      const libraries = await choice("库方案：1 仅个人库；2 仅团队库；3 个人库 + 团队库 [默认 1]：", ["1", "2", "3"], "1");
      const dual = libraries === "3";
      if (dual && current.url && !currentRole) {
        const role = await choice("已有全局默认连接属于哪个库？1 个人库；2 团队库；3 不复用 [默认 3]：", ["1", "2", "3"], "3");
        currentRole = { "1": "local", "2": "team" }[role];
        if (currentRole) oldValues[currentRole] = current;
      }
      for (const role of (dual ? ["local", "team"] : [libraries === "1" ? "local" : "team"])) {
        values[role] = await connection(roleName(role), oldValues[role] || (!dual ? current : {}));
      }
      say("第 2 步：选择全局默认用法。随后可为各项目单独设置是否启用及使用哪个库。");
      if (dual) {
        const usage = await choice("默认用法：1 全局默认使用个人库，稍后可指定项目使用团队库（推荐）；2 全局默认使用团队库，稍后可指定项目使用个人库；3 全局默认关闭记忆，稍后按项目开启并选择个人库或团队库 [默认 1]：", ["1", "2", "3"], "1");
        all = usage !== "3";
        writeRole = usage === "2" ? "team" : "local";
        if (!all) writeRole = (await choice("全局默认关闭时，仍需保存一个默认库，供项目单独开启但未选库时使用：1 个人库；2 团队库 [默认 1]：", ["1", "2"], "1")) === "1" ? "local" : "team";
      } else {
        writeRole = Object.keys(values)[0];
        all = (await choice(roleName(writeRole) + "的使用范围：1 全局默认使用" + roleName(writeRole) + "；2 全局默认关闭记忆，稍后按项目开启 [默认 1]：", ["1", "2"], "1")) === "1";
      }
      say("第 3 步：设置全局默认读取方式。项目可单独调整；无论如何读取，每次写入都只进入当前使用的一个库。");
      const mode = dual && (await choice("读取方式：1 全局默认分开读取，只读当前使用的库（推荐）；2 全局默认一起读取，同时查询个人库和团队库 [默认 1]：", ["1", "2"], "1")) === "2" ? "combined" : "separate";
      routing = updateRouting(routing, { global: true, mode }, home);
      if (mode === "combined") say("已选择一起读取：查询会发送到个人库和团队库；写入仍只进入当前使用的库。");
    } else {
      if (!writeRole) {
        writeRole = (await choice("已有全局默认连接的用途：1 个人库；2 团队库 [默认 1]：", ["1", "2"], "1")) === "1" ? "local" : "team";
        oldValues[writeRole] = current;
      }
      Object.assign(values, oldValues);
      values[writeRole] = current;
      say("此入口保留已保存的库连接和全局默认读取方式（" + readName(routing.mode) + "）。下方可调整全局启用状态，再逐项目设置选库和读取方式。");
      const range = await choice("全局默认用法：1 保留当前全局默认设置；2 全局默认使用" + roleName(writeRole) + "；3 全局默认关闭记忆，保留项目单独开启的设置 [默认 1]：", ["1", "2", "3"], "1");
      preserveScope = range === "1";
      if (range !== "1") all = range === "2";
    }
    if (Object.keys(routing.directories || {}).length || Object.keys(routing.writeDirectories || {}).length) {
      showRules("已有项目选库规则：", routing.writeDirectories, roleName);
      showRules("已有目录读取规则：", routing.directories, readName);
      say("保留规则时，部分项目可能继续使用不同的库或跨库读取；清除规则不会删除项目已有的独立配置和开关。");
      if ((await choice("已有项目选库和目录读取规则：1 保留已有规则，稍后可逐项目调整；2 清除已有选库和读取规则，重新设置 [默认 1]：", ["1", "2"], "1")) === "2") {
        routing.directories = {};
        routing.writeDirectories = {};
      }
    }
    routing.writeSource = writeRole;
    const projects = [];
    const projectPlans = new Map();
    const sharedProjects = new Set();
    const mixedScope = preserveScope && codex.plugins?.[PLUGIN]?.enabled !== codex.mcp_servers?.[SERVER]?.enabled;
    const defaultDescription = mixedScope
      ? "沿用现有开关（插件" + flagName(codex.plugins?.[PLUGIN]?.enabled) + "、独立 MCP " + flagName(codex.mcp_servers?.[SERVER]?.enabled) + "），默认库为" + roleName(writeRole)
      : (all ? "使用" + roleName(writeRole) + "，" + readName(routing.mode) : "关闭记忆");
    say("全局默认：" + defaultDescription + "。");
    say("项目单独设置：可指定任意位置的项目。选择已保存的个人库或团队库，无需重复填写 API Key。");
    say("输入项目绝对路径（支持 ~/），直接回车结束；运行向导所在目录不会被自动选中。");
    while (true) {
      const answer = await ask("要设置的项目路径（回车结束）：");
      if (!answer) {
        if (full && !all && ![...projectPlans.values()].some((plan) => plan.enabled)) { say("全局默认已关闭记忆，请至少添加一个项目并选择个人库、团队库或独立连接以开启记忆。"); continue; }
        break;
      }
      let project;
      try { project = directory(answer); }
      catch { say("路径无效：请填写已存在项目的绝对路径，不能选择用户主目录或安装包目录。"); continue; }
      if (projects.includes(project)) { say("该项目已设置。如需重设，可保存后重新运行向导，选择“调整项目规则与全局启用状态”。"); continue; }
      const available = [values.local ? "1 使用已保存的个人库" : "", values.team ? "2 使用已保存的团队库" : ""].filter(Boolean);
      const defaultOption = all ? "3 跟随全局默认（" + roleName(writeRole) + "）" : "3 跟随全局默认（关闭记忆）";
      const allowed = [...(values.local ? ["1"] : []), ...(values.team ? ["2"] : []), "3", "4", "5", "6"];
      const suggestion = full && !all ? (values[writeRole] ? (writeRole === "local" ? "1" : "2") : "4") : (values.team && writeRole === "local" ? "2" : "3");
      const selected = await choice(project + " 的使用方式：" + [...available, defaultOption, "4 使用另一个连接（高级）", "5 关闭此项目记忆", "6 保留此项目现有设置"].join("；") + " [默认 " + suggestion + "]：", allowed, suggestion);
      projects.push(project);
      if (selected === "6") {
        const existing = toml(join(project, ".codex", "config.toml"));
        const enabled = Boolean((existing.plugins?.[PLUGIN]?.enabled ?? all) && (existing.mcp_servers?.[SERVER]?.enabled ?? all));
        projectPlans.set(project, { enabled, text: "保留现有项目设置" });
        continue;
      }
      const path = join(project, ".codex", "config.toml");
      const config = toml(path);
      if (connectionOverride(config.mcp_servers?.[SERVER]?.env)) throw new Error("项目 MCP 有连接/身份环境变量覆盖；请先移除覆盖再设置该项目。");
      const merged = mergeCodexConfig(config, { packageRoot, nodePath: process.execPath, stateHome: state });
      const enabled = selected !== "5" && (selected !== "3" || all);
      if (selected === "3") {
        delete merged.plugins[PLUGIN].enabled;
        delete merged.mcp_servers[SERVER].enabled;
      } else {
        merged.plugins[PLUGIN].enabled = enabled;
        merged.mcp_servers[SERVER].enabled = enabled;
      }
      put(path, merged, stringify);
      if (selected === "5") {
        projectPlans.set(project, { enabled: false, text: "关闭记忆；保留已保存连接" });
        continue;
      }
      const projectPath = join(project, ".openviking", "ovcli.conf");
      const existing = json(projectPath);
      const inherited = selected === "3";
      const custom = selected === "4";
      let role = inherited ? "default" : { "1": "local", "2": "team" }[selected];
      if (custom) {
        const value = await connection("项目独立连接（仅此项目及其子目录）", existing);
        ignoreCredentials(project);
        put(projectPath, value);
        privateDirectories.add(dirname(projectPath));
        registry[projectPath] = value.url;
        routing = updateRouting(routing, { write: true, mode: "inherit" }, project);
      } else {
        // Shared sources live in user state; remove an explicitly replaced legacy project credential.
        if (snapshot(projectPath).before !== null) {
          ignoreCredentials(project);
          privateDirectories.add(dirname(projectPath));
        }
        snapshot(projectPath).after = null;
        snapshot(projectPath).write = true;
        delete registry[projectPath];
        routing = updateRouting(routing, { write: true, mode: role }, project);
        sharedProjects.add(project);
      }
      let readMode = "separate";
      if (inherited) readMode = "inherit";
      else if (values.local && values.team) {
        const mode = await choice("该项目读取方式：1 此项目分开读取，只读项目选择的库（推荐）；2 此项目一起读取，同时查询个人库和团队库；3 此项目继承上级目录或全局默认读取方式；4 保留此项目现有读取规则 [默认 1]：", ["1", "2", "3", "4"], "1");
        readMode = { "1": "separate", "2": "combined", "3": "inherit", "4": "keep" }[mode];
      }
      if (readMode !== "keep") routing = updateRouting(routing, { mode: readMode }, project);
      projectPlans.set(project, { enabled, text: inherited ? "跟随全局默认（" + defaultDescription + "）" : (custom ? "独立连接" : "使用" + roleName(role)) });
    }
    if (!preserveScope) {
      codex = mergeCodexConfig(codex, { packageRoot, nodePath: process.execPath, stateHome: state });
      codex.plugins[PLUGIN].enabled = all;
      codex.mcp_servers[SERVER].enabled = all;
      put(codexPath, codex, stringify);
    }
    if (full) put(globalPath, values[writeRole]);
    const needed = new Set(Object.keys(values));
    for (const role of Object.values(routing.writeDirectories || {})) if (role !== "default") needed.add(role);
    if ([routing.mode, ...Object.values(routing.directories || {})].includes("combined")) { needed.add("local"); needed.add("team"); }
    const sources = {};
    const sourceUrls = {};
    for (const role of needed) {
      const value = values[role] || oldValues[role];
      if (!value?.url) throw new Error("保留的项目规则仍需要" + roleName(role) + "。请配置该库，或清除相关旧规则后重试。");
      sourceConfig(role, "", {}, value);
      const path = role === writeRole ? globalPath : join(state, "read-sources", role + ".ovcli.conf");
      sources[role] = path;
      sourceUrls[role] = (full && values[role]) ? value.url : (routing.sourceUrls?.[role] || value.url);
      if (path !== globalPath) {
        put(path, value);
        privateDirectories.add(dirname(path));
      }
    }
    routing.sources = sources;
    routing.sourceUrls = sourceUrls;
    put(routingPath, routing);
    if (JSON.stringify(registry) !== JSON.stringify(json(registryPath))) put(registryPath, registry);
    const loadSource = (name, path, primary) => sourceConfig(name, path, primary, json(expandSource(path)));
    const primary = sourceConfig("current", globalPath, {}, json(globalPath));
    const resolved = new Map();
    for (const project of new Set([home, ...projects, ...Object.keys(routing.directories || {}), ...Object.keys(routing.writeDirectories || {}), ...Object.keys(registry).map((path) => dirname(dirname(path)))])) {
      const dir = canonicalDirectory(expandSource(project));
      let active = primary;
      let customPath = null;
      let parent = dir;
      while (parent !== home) {
        const path = join(parent, ".openviking", "ovcli.conf");
        const file = json(path);
        if (registry[path] && !Object.keys(file).length) throw new Error("已批准的项目连接文件缺失：" + path);
        if (Object.keys(file).length) {
          if (sharedProjects.has(dir)) throw new Error("父目录仍有独立连接，不能切换到共享库。请将父项目也加入向导并改为共享库。");
          if (!registry[path] || normalizeConnectionUrl(registry[path]).replace(/\/+$/, "") !== normalizeConnectionUrl(file.url).replace(/\/+$/, "")) throw new Error("项目独立连接尚未批准或服务地址已改变：" + path);
          active = sourceConfig("current", path, {}, file);
          customPath = path;
          break;
        }
        if (existsSync(join(parent, ".git"))) break;
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
      if (!customPath) {
        const shared = resolveSharedConnection(routing, dir, (path) => json(path));
        if (shared?.path) active = sourceConfig("current", shared.path, {}, shared.cliFile);
      }
      const plan = resolveReadRouting(active, routing, dir, routingPath, loadSource);
      resolved.set(dir, { active, plan });
    }
    say("保存前确认");
    say("全局默认：" + defaultDescription + "。默认连接：" + displayUrl(primary.baseUrl));
    for (const [project, plan] of projectPlans) {
      const actual = resolved.get(project);
      say(project + "：" + plan.text + (plan.enabled && actual ? "；实际连接 " + displayUrl(actual.active.baseUrl) + "；" + readName(actual.plan.mode) : ""));
    }
    showRules("最终项目选库规则：", routing.writeDirectories, roleName);
    showRules("最终目录读取规则：", routing.directories, readName);
    say("未列出的项目自身开关和独立连接保留；仅关闭全局默认不会撤销已有项目显式启用。项目需受 Codex 信任才会加载配置。");
    const changed = [...files].filter(([, file]) => !same(file.before, file.after));
    say("将更新以下文件，原内容会备份到用户目录 setup-backups：\n" + changed.map(([path, file]) => path + (file.after === null ? "（移除旧项目连接）" : "")).join("\n"));
    say("Key 不显示、不写入共享连接项目。已校验格式和路由，未联网验证服务或 Key 权限。");
    if ((await choice("确认保存以上方案？y 保存；n 取消，本次配置不变 [默认 n]：", ["y", "n"], "n")) !== "y") return { written: false };
    const written = commit(files, [join(state, ".setup.lock"), routingPath + ".lock", join(dirname(codexPath), ".openviking-project-memory-install.lock")], privateDirectories, join(state, "setup-backups"), () => {
      for (const project of projects) {
        const file = files.get(join(project, ".openviking", "ovcli.conf"));
        if (file?.write && (file.before !== null || file.after !== null)
          && [".openviking/ovcli.conf", ".openviking/ovcli.conf.backup-probe"].some((path) => git(project, ["check-ignore", "-q", path]).status !== 0)) throw new Error("项目凭据忽略检查失败。");
      }
    });
    say("配置已保存。请重启 Codex 并新建聊天。以后可运行 openviking-project-memory setup 调整全局默认或项目规则。");
    if (Object.keys(written.backups).length) say("恢复备份索引：" + join(dirname(Object.values(written.backups)[0]), "manifest.json"));
    return { written: true, ...written };
  } finally { rl?.close(); }
}
