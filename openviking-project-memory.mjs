#!/usr/bin/env node
import { install } from "./scripts/install.mjs";
import { setupAfterInstall } from "./scripts/setup-after-install.mjs";

const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === "install") { install(); await setupAfterInstall(); }
  else if (args.length === 1 && args[0] === "setup") {
    const { runSetupWizard } = await import("./scripts/setup-wizard.mjs");
    await runSetupWizard();
  } else if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    console.log("用法：openviking-project-memory install  注册或修复插件与独立 MCP，然后检查连接配置\n      openviking-project-memory setup    配置库、全局默认用法、项目规则及读取范围\n      ov-memory status                  查看当前目录使用的连接和读取方式");
  } else throw new Error("未知命令，请运行 openviking-project-memory --help 查看用法。");
} catch (error) {
  console.error("OpenViking Project Memory: " + error.message);
  process.exitCode = 1;
}
