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

## 2. 选择连接方式（个人库不是必需项）

先选择使用场景。连接配置决定使用哪个库，插件和独立 MCP 的开关决定哪些项目启用。

| 使用场景 | 全局默认连接 | 读取模式 | 插件和独立 MCP 启用范围 | 项目额外配置 |
|---|---|---|---|---|
| 有个人库，只使用个人库 | 个人库 | `separate` | 全局启用 | 无 |
| 有个人库，同时使用团队库 | 个人库 | `combined`，也可按目录设为 `separate` | 默认全局启用 | 写团队的项目配置团队连接并登记 |
| 没有个人库，方式 A | 团队库 | `separate` | 全局启用 | 共用全局连接时无需配置 |
| 没有个人库，方式 B | 团队库 | `separate` | 全局关闭，指定项目启用 | 只配置项目启用开关 |

`~/.openviking/ovcli.conf` 表示“全局默认连接”，可以指向个人服务，也可以指向团队服务。有个人库时同样可以选择仅指定项目启用，开关配置见第 5 节。

### 有个人库：只使用个人库，或同时使用团队库

| 配置文件 | 只使用个人库 | 同时使用个人库和团队库 |
|---|---|---|
| `~/.openviking/ovcli.conf` | 使用 `examples/personal.ovcli.example.json`，填写个人地址和 Key | 同左 |
| `~/.openviking/read-sources/team.ovcli.conf` | 不需要 | 使用 `examples/team.ovcli.example.json`，填写团队地址和自己的团队 Key |
| `~/.openviking/read-routing.json` | 使用 `examples/read-routing.separate.example.json` | 使用 `examples/read-routing.example.json`，按第 4 节设置目录规则 |
| 用户级 `~/.codex/config.toml` | 合并 `examples/codex-config.example.toml` | 同左 |
| 项目 `.openviking/ovcli.conf` 和用户级登记 | 不需要 | 仅写团队的项目按第 3 节配置；其他项目仍写个人库 |

以上文件已有配置时合并，不直接覆盖。双库读取只改变检索来源，不会同时写两个库。

双库方式创建下面的两个连接文件后，在 macOS/Linux 上把凭据目录设为 `0700`、凭据文件设为 `0600`。单库方案只对实际创建的文件设置权限。备份中也可能含 Key，不公开分享。

```sh
mkdir -p "$HOME/.openviking/read-sources"
chmod 700 "$HOME/.openviking" "$HOME/.openviking/read-sources"
chmod 600 "$HOME/.openviking/ovcli.conf" "$HOME/.openviking/read-sources/team.ovcli.conf"
```

只使用一个库时，将读取配置设为 `{"mode":"separate","directories":{}}`，不需要 `sources`。这个单库既可以是个人库，也可以是团队库。没有读取配置文件时也默认单库。已有配置时检查目录覆盖，不能保留某些目录的 `combined` 规则却省略第二来源。

### 方式 A：没有个人库，所有项目默认使用团队库

1. 把 `examples/team.ovcli.example.json` 复制为 `~/.openviking/ovcli.conf`，填写团队地址和自己的团队 Key。
2. 把 `examples/read-routing.separate.example.json` 复制为 `~/.openviking/read-routing.json`，或将已有配置改为 `separate` 并清空不需要的目录覆盖。
3. 使用普通全局启用模板 `examples/codex-config.example.toml`。

此时不需要个人服务、不需要 `read-sources/team.ovcli.conf`，也不需要 `sources.local`。没有特殊项目覆盖时，读取和写入都使用全局团队连接。这里不是把团队 Key 填成个人 Key，而是把团队连接设成默认连接。

### 方式 B：全局配置团队连接，只在指定项目启用

1. 把 `examples/team.ovcli.example.json` 复制为 `~/.openviking/ovcli.conf`，填写团队地址和自己的团队 Key。连接只配置一次，无需第二读取来源。
2. 用户级读取配置使用 `examples/read-routing.separate.example.json`，或将已有配置改为 `separate` 并清空不需要的目录覆盖。
3. **安装完成后**，把 `examples/codex-config.project-only.example.toml` 合并进用户级 `~/.codex/config.toml`：全局关闭本插件和独立 MCP（两者均为 `enabled = false`），但保留其启动命令。
4. 在指定项目的 `.codex/config.toml` 合并 `examples/project-codex-config.example.toml`，只在该项目开启插件和独立 MCP（两者均为 `enabled = true`）。项目配置需要由 Codex 信任后加载，MCP 启动命令继承用户级配置。
5. 检查普通目录中两者关闭、指定项目中两者开启，然后重启并新建会话。

共用全局团队连接的项目无需创建 `.openviking/ovcli.conf`，也无需登记 `project-configs.json`。只有项目需要不同连接时，才按第 3 节配置项目覆盖。

**不要只关闭插件而遗漏独立 MCP**。两者都全局关闭后，普通目录不启用本包的自动记忆或 MCP；只有指定项目加载它们。

**省略连接配置不等于自动禁用。** 如果插件或 MCP 仍处于开启状态，且没有项目连接，它会继续解析环境变量或旧 `ov.conf`，最后可能尝试默认 `http://127.0.0.1:1933`。本版本没有“无配置则自动关闭”的开关。

`combined` 模式要求两个完整有效的来源，并且当前写入身份匹配其中之一。只有团队库时应使用 `separate`，不要留下缺失个人来源的双库配置。

## 3. 按需覆盖项目写入连接

没有项目覆盖时，写入使用 `~/.openviking/ovcli.conf` 的默认连接；该连接可以是个人库或团队库。方式 B 通过全局关闭插件和独立 MCP、指定项目开启两者来控制启用范围，连接仍使用全局默认。

| 项目需求 | 是否需要项目连接和登记 | 写入目标 |
|---|---|---|
| 使用全局个人连接 | 否 | 个人库 |
| 使用全局团队连接（方式 A、B） | 否 | 团队库 |
| 全局是个人连接，当前项目要写团队 | 是 | 项目配置的团队库 |
| 当前项目需要另一个团队连接 | 是 | 项目配置的团队库 |

只有需要覆盖全局默认连接的项目，才在 Git 根目录创建 `.openviking/ovcli.conf`，内容使用该项目的团队连接。将该目录加入本地 Git 的 `info/exclude` 或项目 `.gitignore`，确认 `git check-ignore .openviking/ovcli.conf` 能匹配；文件设为 `0600`，目录设为 `0700`。

随后在 `~/.openviking/project-configs.json` 登记“项目配置文件的实际绝对路径 → 团队服务地址”。示例见 `examples/project-configs.example.json`。地址必须与项目连接文件一致。

项目覆盖未登记、配置损坏、地址不符或已登记但文件缺失时会停止发送。没有项目连接覆盖时，登记文件可省略或设为 `{}`。

## 4. 设置目录级读取模式

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

模式切换不改变写入目标或插件启用状态；修改后重启 Codex 并新建会话。终端和技能的切换方法见第 7 节。

来源与目录规则只在用户目录管理，不允许仓库自行提供新的检索地址。当前写入身份需匹配双库来源之一。团队 Key 变化时同时维护团队来源和相关项目配置。

## 5. 合并 Codex 配置并安装

按选择的使用方式，把对应模板合并到 `~/.codex/config.toml`：全局使用选 `examples/codex-config.example.toml`，仅指定项目使用选 `examples/codex-config.project-only.example.toml`。填写 Node、项目目录和用户目录的实际绝对路径。不要覆盖现有模型、其他 MCP 和写目录，也不要重复声明同名 TOML 表。

| 配置位置 | 所有项目默认启用 | 仅指定项目启用 |
|---|---|---|
| 用户级插件 `enabled` | `true` | `false` |
| 用户级独立 MCP `enabled` | `true`（模板省略时默认启用） | `false`，保留 `command`、`args` 等启动配置 |
| 用户级插件内置 MCP `enabled` | `false` | `false` |
| 指定项目 `.codex/config.toml` | 无需额外启用 | 合并 `examples/project-codex-config.example.toml`，插件和独立 MCP 均设为 `true` |

本包独立 marketplace 名称为 `openviking-project`；插件标识为 `openviking-memory@openviking-project`。原版若已启用，应先关闭原版对应条目，避免同一聊天被两组 hooks 重复捕获。

插件内置 MCP 需要关闭，改用模板中的独立 `mcp_servers.openviking-memory` 启动本包代理。不要给该 MCP 固定 `cwd`，让它继承当前项目目录。配置中的 `~`、`$HOME` 不应被假定自动展开，TOML 路径请填实际绝对路径。

在终端执行：

```sh
codex plugin marketplace add "/absolute/path/to/openviking-project-memory"
codex plugin add openviking-memory@openviking-project
```

安装命令可能启用插件。仅项目使用方案应在安装命令完成后再次应用全局禁用模板，并核对全局插件与独立 MCP 都是 `enabled = false`，然后再启动新会话。

完成后重启 Codex，审核新的 hooks，并在目标项目新建会话。克隆或解压源码不会自动完成安装、建立服务或填写凭据。

不要运行 `setup-helper/` 中的上游联网安装脚本来安装本扩展；那些是保留的上游文件，可能安装回官方版本。历史说明见 `UPSTREAM-README.md`，本扩展以本文安装步骤为准。

## 6. 验证

先检查模板占位符已替换、凭据未进入 Git，再检查：

```sh
codex plugin list --marketplace openviking-project
codex mcp get openviking-memory
```

分别在单库和双库目录中新建会话，确认选择的读取来源和写入目标。双库 MCP 的 `find`、`search`、`read`、`list`、`tree`、`grep`、`glob`、`health` 默认读取两端；可用 `_ov_source` 选择 `all`、`local`、`team`、`current`。写工具始终只发送当前库，不能用该参数改为副库写入。

核心验证使用临时目录、合成内容和模拟服务。下面的命令包含路由、状态锁、归档安全、配置快照、MCP 和诊断回归：

```sh
node --test --test-concurrency=1 codex-memory-plugin/scripts/read-routing.test.mjs codex-memory-plugin/scripts/combined-read-hooks.test.mjs codex-memory-plugin/scripts/combined-capture.test.mjs codex-memory-plugin/servers/combined-read.test.mjs codex-memory-plugin/scripts/ov-memory.test.mjs codex-memory-plugin/scripts/project-config.test.mjs codex-memory-plugin/scripts/project-routing.integration.test.mjs codex-memory-plugin/scripts/session-state.test.mjs codex-memory-plugin/scripts/capture-safety.test.mjs codex-memory-plugin/scripts/credentials-snapshot.test.mjs codex-memory-plugin/scripts/doctor.test.mjs codex-memory-plugin/servers/mcp-config-regression.test.mjs codex-memory-plugin/scripts/hook-paths.test.mjs verify-package.test.mjs
```

上游的 `marketplace.test.mjs` 依赖完整上游仓库布局，不适用于单独安装快照；本项目使用 `verify-package.mjs` 检查源码快照结构；Git 自身的 `.git` 元数据不参与校验。完整验证步骤与真实环境核对见 [验证指南](codex-memory-plugin/VERIFICATION.md)。包内各 `*-VERIFICATION.json` 是打包时的历史记录，不会随本次命令执行自动更新。

## 7. 用命令切换，或在 Codex 中调用技能

不安装终端别名也能直接用 Node 运行包根入口，例如 `node "/实际项目目录/ov-memory.mjs" status`。先进入要操作的工作目录，插件路径不等于操作目标目录。

需要简短的 `ov-memory` 命令时，可创建用户级命令链接：

```sh
mkdir -p "$HOME/.local/bin"
chmod +x "/实际项目目录/ov-memory.mjs"
ln -s "/实际项目目录/ov-memory.mjs" "$HOME/.local/bin/ov-memory"
export PATH="$HOME/.local/bin:$PATH"
```

已有同名命令时先核对来源，不直接覆盖。若新终端没有该 PATH，按所用 shell 的设置方式保留该目录。

终端与 Codex 技能使用同一套规则。下表的终端命令使用已配置的 `ov-memory` 链接；未配置链接时，将 `ov-memory` 替换为 `node "/实际项目目录/ov-memory.mjs"`。

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
- 配置文件本身是软链接时，命令会拒绝操作；工作目录的软链接可正常归一化。

本包的 `ov-memory` 技能在 Codex 中显示为 `openviking-memory:ov-memory`。技能随插件提供，在启用本插件的 Codex 项目中重启后可使用，不需要再复制到用户的独立 skills 目录，也不依赖终端别名已安装。技能调用同一份 CLI，默认当前目录，只有明确要求全局时才传 `--global`。

命令修改的是配置文件，不代表运行中的 MCP 已热切换。`status` 将当前活跃 MCP 模式标为未知；修改后重启 Codex 并新建会话。命令不改 Key、写入目标、插件启用状态或记忆数据。

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

分发保留完整源码、上游归属与修改说明。上游 examples 目录的 Apache-2.0 许可及归属说明见 `LICENSE` 和 `NOTICE.md`，历史来源核对记录见 `upstream-provenance.json`。
