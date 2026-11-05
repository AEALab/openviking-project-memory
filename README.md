# OpenViking Project Memory

这是基于 OpenViking Codex memory plugin 0.7.7 的社区扩展版，当前插件内部版本为 `0.7.7-project.4`。支持按工作目录选择单库或双库读取，写入仍按项目隔离。本包不是官方发布版。

包内提供完整插件源码、测试、安装目录描述和配置模板。没有任何使用者的真实 Key、个人路径、团队内网地址、会话记录或记忆数据。

## 使用前需要什么

- 支持本地 marketplace、插件 hooks 和 MCP 的 Codex。
- Node.js 22 或更新版本；运行 `node --version` 和 `command -v node` 核对版本、实际路径。
- 至少一个可访问的 OpenViking 服务和对应 Key；可以只有团队库，不要求个人库。需要双库读取时才配置两个有效来源。服务需支持本插件使用的 REST 接口、`/mcp` 和 `viking://~` 别名。

没有 npm 依赖，不需要构建。本包不会安装或启动 OpenViking 服务，也不提供任何服务访问凭据。

本文命令面向 macOS/Linux；Windows 用户需要自行替换命令、路径和权限设置，尚未验证 Windows 安装流程。

## 1. 获取源码并保留固定目录

将仓库克隆到长期保留的目录：

```sh
git clone https://github.com/AEALab/openviking-project-memory.git
cd openviking-project-memory
```

也可以下载仓库 ZIP 后解压。目录名称固定，不需要带版本号；
插件内部版本号用于 Codex 缓存与升级识别。

在 Codex 中可把这个目录交给 AI，要求先读取本 README，
再按第 2 节选择的场景安装；需要提供自己的服务地址、Key 和启用范围。

在项目根目录运行结构与校验和检查：

```sh
node verify-package.mjs
```

先退出正在运行的 Codex 桌面应用，在完成配置前不要启动新的会话。以下示例中的绝对路径、服务地址与 Key 都需要替换。

## 2. 快速开始：配置一个库

首次使用只需要一份全局连接和一份启用模板。先配置一个库；需要双库读取或项目使用不同连接时，再看第 6 节。

| 你要使用的库 | 示例文件 | 保存位置 |
|---|---|---|
| 个人库 | `examples/personal.ovcli.example.json` | `~/.openviking/ovcli.conf` |
| 团队库（没有个人库也可以） | `examples/team.ovcli.example.json` | `~/.openviking/ovcli.conf` |

先创建 `~/.openviking` 目录，选择其中一个示例复制到保存位置，填写服务地址和自己的 Key。`ovcli.conf` 是全局默认连接，不要求它是个人库；已有文件时先核对、合并，不直接覆盖。

在 macOS/Linux 上，创建连接文件后设置权限：

```sh
chmod 700 "$HOME/.openviking"
chmod 600 "$HOME/.openviking/ovcli.conf"
```

| 配置项 | 单库快速开始是否需要 |
|---|---|
| `~/.openviking/ovcli.conf` | 需要，全局配置一次 |
| `~/.openviking/read-routing.json` | 新安装不需要，没有该文件时默认单库 `separate` |
| 第二个读取来源 | 不需要 |
| 项目 `.openviking/ovcli.conf` 和 `project-configs.json` 登记 | 共用全局连接时不需要 |

已有读取配置时，不要为了简化安装删除它；先检查全局模式和目录规则。若只使用一个库，可参考 `examples/read-routing.separate.example.json` 设为 `separate`，并移除不再需要的双库目录覆盖。读取模式的命令见第 5 节。

## 3. 选择启用范围

连接配置决定用哪个库；插件和独立 MCP 的开关决定哪些项目启用。个人库和团队库都使用下表。

| 启用方式 | 用户级配置模板 | 项目操作 |
|---|---|---|
| 所有项目默认启用（团队单库的方式 A） | `examples/codex-config.example.toml` | 无需额外启用 |
| 仅指定项目启用（团队单库的方式 B） | `examples/codex-config.project-only.example.toml` | 在指定项目 `.codex/config.toml` 合并 `examples/project-codex-config.example.toml` |

把选定的用户级模板合并到 `~/.codex/config.toml`。填写 Node、项目目录和用户目录的实际绝对路径。不要覆盖现有模型、其他 MCP 和写目录，也不要重复声明同名 TOML 表。

| 配置位置 | 所有项目默认启用 | 仅指定项目启用 |
|---|---|---|
| 用户级插件 `enabled` | `true` | `false` |
| 用户级独立 MCP `enabled` | `true`（模板省略时默认启用） | `false`，保留 `command`、`args` 等启动配置 |
| 用户级插件内置 MCP `enabled` | `false` | `false` |
| 指定项目 `.codex/config.toml` | 无需额外启用 | 合并 `examples/project-codex-config.example.toml`，插件和独立 MCP 均设为 `true` |

本包独立 marketplace 名称为 `openviking-project`；插件标识为 `openviking-memory@openviking-project`。原版若已启用，应先关闭原版对应条目，避免同一聊天被两组 hooks 重复捕获。

插件内置 MCP 需要关闭，改用模板中的独立 `mcp_servers.openviking-memory` 启动本包代理。不要给该 MCP 固定 `cwd`，让它继承当前项目目录。配置中的 `~`、`$HOME` 不应被假定自动展开，TOML 路径请填实际绝对路径。

共用全局连接的项目只需按上表设置启用范围，不复制 Key，也不登记项目连接。项目配置需要由 Codex 信任后加载，独立 MCP 的启动命令继承用户级配置。

**插件和独立 MCP 要一起开启或关闭。** 省略连接文件不会自动禁用插件；启用时仍可能使用环境变量、旧 `ov.conf` 或默认服务地址。

## 4. 安装并验证

在终端执行：

```sh
codex plugin marketplace add "/absolute/path/to/openviking-project-memory"
codex plugin add openviking-memory@openviking-project
```

安装命令可能启用插件。仅项目使用方案应在安装命令完成后再次应用全局禁用模板，并核对全局插件与独立 MCP 都是 `enabled = false`，然后再启动新会话。

完成后重启 Codex，审核新的 hooks，并在目标项目新建会话。克隆或解压源码不会自动完成安装、建立服务或填写凭据。

不要运行 `setup-helper/` 中的上游联网安装脚本来安装本扩展；那些是保留的上游文件，可能安装回官方版本。历史说明见 `UPSTREAM-README.md`，本扩展以本文安装步骤为准。

在目标项目中检查模板占位符已替换、凭据未进入 Git，再运行：

```sh
codex plugin list --marketplace openviking-project
codex mcp get openviking-memory
node "/实际项目目录/ov-memory.mjs" status
```

| 启用方式 | 新会话中应检查的结果 |
|---|---|
| 所有项目默认启用 | 目标项目能使用自动记忆和 MCP，读写使用所选全局连接 |
| 仅指定项目启用 | 普通目录的插件和独立 MCP 均关闭；指定项目中两者开启，使用所选全局连接 |

`status` 显示配置文件的有效模式，不能证明当前 MCP 进程已按新配置启动。配置完成后重启 Codex 并在目标项目新建会话核对。

## 5. 日常使用：查看和切换读取模式

不安装终端别名也能直接用 Node 运行包根入口，例如 `node "/实际项目目录/ov-memory.mjs" status`。先进入要操作的工作目录，插件路径不等于操作目标目录。

终端与 Codex 技能使用同一套规则。下表用 `ov-memory` 简写终端入口；未安装命令链接时，将它替换为 `node "/实际项目目录/ov-memory.mjs"` 即可，例如 `node "/实际项目目录/ov-memory.mjs" read separate --global`。

| 目的 | 终端命令 | Codex 技能用法 | 影响范围 |
|---|---|---|---|
| 查看配置 | `ov-memory status` | `$openviking-memory:ov-memory 查看当前目录的记忆配置` | 只读，不修改 |
| 当前目录单库 | `ov-memory read separate` | `$openviking-memory:ov-memory 把当前目录改成单库读取` | 当前目录及继承它的子目录 |
| 当前目录双库 | `ov-memory read combined` | `$openviking-memory:ov-memory 把当前目录改成双库读取` | 当前目录及继承它的子目录 |
| 当前目录恢复继承 | `ov-memory read inherit` | `$openviking-memory:ov-memory 让当前目录恢复继承` | 移除当前目录规则，继续继承父目录或全局 |
| 全局默认单库 | `ov-memory read separate --global` | `$openviking-memory:ov-memory 把全局默认改成单库读取` | 没有目录覆盖的范围，已有目录规则保留 |
| 全局默认双库 | `ov-memory read combined --global` | `$openviking-memory:ov-memory 把全局默认改成双库读取` | 没有目录覆盖的范围，已有目录规则保留 |

终端以执行命令时的工作目录为准，技能默认以当前工作区为准；两者将规则保存在用户级 `~/.openviking/read-routing.json`，不会在项目内生成读取配置。其他平级目录不受当前目录切换影响；子目录有自己的规则时，继续使用自己的规则。双库切换要求已配置两个有效来源。

- `status` 只读，不访问记忆服务，不创建配置或备份；显示当前目录、全局默认、最近目录规则、配置有效模式和写入来源，不打印 Key。
- 不加 `--global` 只修改当前目录；`inherit` 只删除当前目录的规则，继续继承父目录或全局。
- `--global` 只改全局默认，保留已有目录规则；`inherit --global` 不受支持。
- 当前模式相同或无需删除规则时，不重写文件、不创建备份。
- 需要改动时，先复用运行时校验，再把原文件以 0600 权限备份到 `read-routing.json.backup-...`，然后原子替换。错误配置、来源缺失、身份不符或保存失败会停止操作。
- 通过独占锁避免两个命令互相覆盖；竞争时提示重试。若进程被强制终止留下 `read-routing.json.lock`，先核对锁中 PID、确认没有写入命令运行后再移除，不能自动强删。
- 配置文件本身是软链接时，只读状态命令会跟随链接读取，修改命令会拒绝操作；工作目录的软链接可正常归一化。

本包的 `ov-memory` 技能在 Codex 中显示为 `openviking-memory:ov-memory`。技能随插件提供，在启用本插件的 Codex 项目中重启后可使用，不需要再复制到用户的独立 skills 目录，也不依赖终端别名已安装。技能调用同一份 CLI，默认当前目录，只有明确要求全局时才传 `--global`。

命令修改的是配置文件，不代表运行中的 MCP 已热切换。`status` 将当前活跃 MCP 模式标为未知；修改后重启 Codex 并新建会话。命令不改 Key、写入目标、插件启用状态或记忆数据。

### 可选：安装简短的终端命令

需要简短的 `ov-memory` 命令时，可创建用户级命令链接：

```sh
mkdir -p "$HOME/.local/bin"
chmod +x "/实际项目目录/ov-memory.mjs"
ln -s "/实际项目目录/ov-memory.mjs" "$HOME/.local/bin/ov-memory"
export PATH="$HOME/.local/bin:$PATH"
```

已有同名命令时先核对来源，不直接覆盖。若新终端没有该 PATH，按所用 shell 的设置方式保留该目录。

## 6. 进阶：双库读取和项目连接覆盖

只有需要同时读两个库，或某个项目需要不同写入连接时，才需要本节。第 2～4 节已足够完成单库安装。

### 同时读取个人库和团队库

| 配置文件 | 内容 |
|---|---|
| `~/.openviking/ovcli.conf` | 个人连接，参考 `examples/personal.ovcli.example.json` |
| `~/.openviking/read-sources/team.ovcli.conf` | 团队连接，参考 `examples/team.ovcli.example.json` |
| `~/.openviking/read-routing.json` | 两个读取来源及目录规则，参考 `examples/read-routing.example.json` |
| 用户级和项目级 Codex 配置 | 沿用第 3 节选定的启用范围 |

先创建 `~/.openviking/read-sources` 目录，再按表中位置保存连接和读取配置；已有配置时合并，不直接覆盖。创建连接文件后设置权限；备份中也可能含 Key，不公开分享。

```sh
chmod 700 "$HOME/.openviking" "$HOME/.openviking/read-sources"
chmod 600 "$HOME/.openviking/ovcli.conf" "$HOME/.openviking/read-sources/team.ovcli.conf"
```

`combined` 要求两个完整有效的来源，且当前写入身份匹配其中之一。双库读取不会同时写两个库；默认仍写全局个人连接，项目要写团队时按下节覆盖。

双库 MCP 的 `find`、`search`、`read`、`list`、`tree`、`grep`、`glob`、`health` 默认读取两端；可用 `_ov_source` 选择 `all`、`local`、`team`、`current`。写工具始终只发送当前库，不能用该参数改为副库写入。

### 按需覆盖项目写入连接

没有项目覆盖时，写入使用 `~/.openviking/ovcli.conf` 的默认连接；该连接可以是个人库或团队库。方式 A、B 共用全局连接时都不需要项目覆盖。

| 项目需求 | 是否需要项目连接和登记 | 写入目标 |
|---|---|---|
| 使用全局个人连接 | 否 | 个人库 |
| 使用全局团队连接（方式 A、B） | 否 | 团队库 |
| 全局是个人连接，当前项目要写团队 | 是 | 项目配置的团队库 |
| 当前项目需要另一个团队连接 | 是 | 项目配置的团队库 |

只有需要覆盖全局默认连接的项目，才在 Git 根目录创建 `.openviking/ovcli.conf`，内容使用该项目的团队连接。将该目录加入本地 Git 的 `info/exclude` 或项目 `.gitignore`，确认 `git check-ignore .openviking/ovcli.conf` 能匹配；文件设为 `0600`，目录设为 `0700`。

随后在 `~/.openviking/project-configs.json` 登记“项目配置文件的实际绝对路径 → 团队服务地址”。示例见 `examples/project-configs.example.json`。地址必须与项目连接文件一致。

项目覆盖未登记、配置损坏、地址不符或已登记但文件缺失时会停止发送。没有项目连接覆盖时，登记文件可省略或设为 `{}`。

### 设置目录级读取模式

`~/.openviking/read-routing.json` 示例：

```json
{
  "mode": "combined",
  "sources": {
    "local": "~/.openviking/ovcli.conf",
    "team": "~/.openviking/read-sources/team.ovcli.conf"
  },
  "directories": {
    "/absolute/path/to/project-a": "separate",
    "/absolute/path/to/project-b": "combined"
  }
}
```

| 配置项或模式 | 含义 |
|---|---|
| `mode` | 未匹配目录的全局默认读取模式 |
| `directories` | 目录覆盖规则，键为实际绝对路径，也支持 `~/`；没有覆盖时留为 `{}` |
| `separate` | 只读当前目录对应的写入库；写个人就只读个人，写团队就只读团队 |
| `combined` | 同时读取个人和团队，自动检索和 MCP 工具均生效 |

规则优先级为：当前目录规则 → 最近的父目录规则 → 全局默认。子目录继承最近匹配的规则，更深的规则优先；`project-a` 不会误匹配 `project-a2`。在子目录切换只创建该子目录规则，不会自动改项目根目录。

模式切换不改变写入目标或插件启用状态；修改后重启 Codex 并新建会话。终端和技能的切换方法见第 5 节。

来源与目录规则只在用户目录管理，不允许仓库自行提供新的检索地址。当前写入身份需匹配双库来源之一。团队 Key 变化时同时维护团队来源和相关项目配置。

## 7. 开发与回归验证

核心验证使用临时目录、合成内容和模拟服务。下面的命令包含路由、状态锁、归档安全、配置快照、MCP 和诊断回归：

```sh
node --test --test-concurrency=1 codex-memory-plugin/scripts/read-routing.test.mjs codex-memory-plugin/scripts/combined-read-hooks.test.mjs codex-memory-plugin/scripts/combined-capture.test.mjs codex-memory-plugin/servers/combined-read.test.mjs codex-memory-plugin/scripts/ov-memory.test.mjs codex-memory-plugin/scripts/project-config.test.mjs codex-memory-plugin/scripts/project-routing.integration.test.mjs codex-memory-plugin/scripts/session-state.test.mjs codex-memory-plugin/scripts/capture-safety.test.mjs codex-memory-plugin/scripts/credentials-snapshot.test.mjs codex-memory-plugin/scripts/doctor.test.mjs codex-memory-plugin/servers/mcp-config-regression.test.mjs codex-memory-plugin/scripts/hook-paths.test.mjs verify-package.test.mjs
```

上游的 `marketplace.test.mjs` 依赖完整上游仓库布局，不适用于单独安装快照；本项目使用 `verify-package.mjs` 检查源码快照结构；Git 自身的 `.git` 元数据不参与校验。完整验证步骤与真实环境核对见 [验证指南](codex-memory-plugin/VERIFICATION.md)。包内各 `*-VERIFICATION.json` 是打包时的历史记录，不会随本次命令执行自动更新。

## 本版修复与运行约束

- REST 和 MCP 均拒绝 HTTP 重定向。服务地址必须填写最终 API 地址；遇到跳转时修正服务或代理配置，不能通过放宽跳转来修复。
- 项目连接验证、凭据、插件设置和会话状态使用同一份配置快照；单库与双库 MCP 在每次工具调用或列举前检查连接及登记，变化后拒绝请求，需重启并新建会话。
- Stop、PreCompact 和会话清理共用会话锁；每批成功发送后立即保存游标。旧状态无连接归属或已损坏时保留文件并停止重放，不会重置游标上传全部历史。
- 如果进程被强制终止，可能留下状态目录内的 `<safe-session-id>.lock`。先核对锁中 PID 并确认进程已退出，再删除该锁后重试；插件不自动强删。此锁与读取配置命令的 `read-routing.json.lock` 用途不同。
- `captureMaxLength` 同时限制实际上传的每条消息中的文本总长度；工具结果仍受独立的 `captureToolMaxChars` 限制。
- 双库启动时发现失败的来源，会在后续 `tools/list` 时重试；主库恢复后可重新显示其写工具。
- 诊断工具区分全局禁用与项目覆盖；未验证项目可信状态时只报告配置证据，不声称已经激活。
- Hook 命令已支持含空格的插件路径，并提供两种路径展开方式的执行回归。

## 数据边界与维护

写入目标隔离不等于语义保密。双库读取会向两端发送查询；直接注入的检索原文与带来源标记的工具结果会从自动归档中剔除，但助手在普通回答中转述的信息仍可能被当前库记录。需要严格区分上下文时选择 `separate`。

同一个会话不能跨写入连接重传。升级包、修改路径或 Key 后重新核对配置与测试，不覆盖历史状态或记忆数据。

等价 URL 写法会归一比较。旧版本会话应先使用原连接配置运行一次，再调整 URL 写法；无法验证的旧身份记录会保留并拒绝恢复，不会自动清零进度。

分发保留完整源码、上游归属与修改说明。上游 examples 目录的 Apache-2.0 许可及归属说明见 `LICENSE` 和 `NOTICE.md`，历史来源核对记录见 `upstream-provenance.json`。
