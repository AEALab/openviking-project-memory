# Verification — OpenViking Project Memory 0.7.7-project.4

本指南适用于当前社区扩展包。安装入口、连接配置和数据边界以
[包根 README](../README.md) 为准。上游历史说明见
[UPSTREAM-README.md](../UPSTREAM-README.md)，其中的联网安装步骤不用于本扩展。

## 1. 文件完整性

在解压后的包根目录执行（需要 Node.js 22+）：

```sh
node verify-package.mjs
```

当前包会核对固定文件数量、完整校验清单、插件清单、四个 Hook、MCP 和技能入口。
命令输出的数量不包含不自校验的 SHA256SUMS.json。源码校验覆盖清单中的所有项目文件，Git 自身的 .git 元数据不计入源码快照。
修改受校验的项目文件后，应同步更新文件数量与 SHA256SUMS.json；Git 的提交、分支和 remote 变化不需要更新清单。

## 2. 隔离功能验证

仍在包根目录执行：

```sh
node --test --test-concurrency=1 codex-memory-plugin/scripts/read-routing.test.mjs codex-memory-plugin/scripts/combined-read-hooks.test.mjs codex-memory-plugin/scripts/combined-capture.test.mjs codex-memory-plugin/servers/combined-read.test.mjs codex-memory-plugin/scripts/ov-memory.test.mjs codex-memory-plugin/scripts/project-config.test.mjs codex-memory-plugin/scripts/project-routing.integration.test.mjs codex-memory-plugin/scripts/session-state.test.mjs codex-memory-plugin/scripts/capture-safety.test.mjs codex-memory-plugin/scripts/credentials-snapshot.test.mjs codex-memory-plugin/scripts/doctor.test.mjs codex-memory-plugin/servers/mcp-config-regression.test.mjs codex-memory-plugin/scripts/hook-paths.test.mjs verify-package.test.mjs
```

上述命令与包根 README 第 6 节一致，覆盖基础功能、新增安全回归和包完整性检查：

- 项目连接选择、子目录继承、异常配置阻断和连接状态隔离。
- 单库／双库自动检索、来源标记、来源离线与超时。
- MCP 双库读取、仅向当前库写入以及配置变化后的重启要求。
- 检索原文归档过滤，以及普通用户／助手内容保留。
- 读取模式命令的当前目录／全局范围、继承、备份、原子保存、
  无操作、互斥锁、校验失败和凭据脱敏。

测试使用临时配置、合成内容和模拟服务，不访问真实记忆库。
上游 marketplace.test.mjs 依赖完整上游仓库布局，独立分享包用
verify-package.mjs 核对安装结构，不运行该上游测试。

包根的 FUNCTIONAL-VERIFICATION.json、INSTALL-VERIFICATION.json、
CLI-VERIFICATION.json 等是打包时的验证记录，不是执行过本指南后自动更新的报告；
其中历史全套测试数量不能当作上述命令的测试数量。

## 3. 安装与真实环境验证

本节由使用者在自己的测试环境执行，会产生真实服务请求；
前面的隔离测试通过不代表已完成本节。

1. 按包根 README 安装 openviking-memory@openviking-project，
   关闭插件内置 MCP，配置继承工作目录的独立 MCP；
   原版插件已启用时先关闭原版，避免重复捕获。
2. 在目标项目运行包根入口：
   `node "/实际解压目录/ov-memory.mjs" status`。
   核对目录、配置读取模式、来源和写入目标。
   此命令不访问服务，也不能证明运行中的 MCP 已加载该配置。
3. 重启 Codex 并新建会话，输入明确的测试偏好；检查自动检索、
   MCP 工具和每轮增量捕获。触发上下文压缩后，
   在所选服务端检查会话提交、归档及异步提取结果。
   提取完成时间由服务端决定，不保证固定秒数。
4. 分别核对 separate 和 combined：
   separate 只读当前写入库；combined 读取 local 和 team，
   MCP 可用 _ov_source 选择来源，写入仍只到当前库。
   缺失、未登记或损坏的项目连接应停止发送。
5. 核对同一会话切换写入连接后会被阻断，不能把旧聊天重传到另一个库。
   模式、路径或 Key 变化后重启并新建会话。
6. 仅指定项目启用方案，还需检查普通目录中的插件和独立 MCP 均关闭，
   指定项目中两者均开启。

默认状态文件位于
`~/.openviking/codex-plugin-state/<connection-scope>/<safe-session-id>.json`；
会话连接绑定位于该状态根目录的 `routes/`。
连接指纹包含服务与认证身份；Key 不明文出现在路径中。
显式设置 OPENVIKING_CODEX_STATE_DIR 时使用指定目录，
测试必须使用独立目录，不应删除或覆盖现有状态。

需要直接调用 Hook 时，将环境变量赋给管道后执行脚本的 Node 进程；
显式连接覆盖使用 OPENVIKING_CLI_CONFIG_FILE。例如：

```sh
printf '%s\n' "$HOOK_INPUT_JSON" | \
  OPENVIKING_CLI_CONFIG_FILE="/实际路径/测试连接.ovcli.conf" \
  OPENVIKING_CODEX_STATE_DIR="/实际路径/独立测试状态目录" \
  node "/实际解压目录/codex-memory-plugin/scripts/auto-capture.mjs"
```

HOOK_INPUT_JSON 需自行提供 session_id 和测试 transcript_path。
该方式显式覆盖项目连接，只用于核对所选连接上的 Hook；
项目自动路由应按前述目标项目新会话流程验证。
不要把连接变量只赋给 printf 或 echo 后，就假定管道后的 Node 会继承。

## 新增回归

包根 README 的完整命令增加了：配置双读替换窗口、固定身份状态、共享状态目录隔离、
并发 Stop／PreCompact、逐批游标保存、GET／POST 跨地址跳转拒绝、实际文本长度、
MCP 撤销／变更阻断、主库恢复、方式 B 诊断、含空格路径和包文件遗漏检查。
这些测试均不得依赖使用者真实 HOME、Key、记忆或 Codex 配置。

锁文件需按包根 README 的 PID 核验流程处理；强制结束进程后的自动强删不受支持。

## 验证边界

Windows 安装流程未验证。双库读取的查询会发送到两端；
直接检索原文虽然会过滤，助手转述的信息仍可能进入当前写入库。
需要严格隔离上下文时使用 separate。
