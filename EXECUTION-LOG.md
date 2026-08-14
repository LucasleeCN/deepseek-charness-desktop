# 阶段 1 执行记录（EXECUTION-LOG）：Windows MVP

承接跨平台客户端执行计划（见上级仓库 `docs/proposals/cross-platform-client-execution-plan.md`）。每完成一个关键节点追加记录并提交至本地分支。

## M1 — 建仓与骨架（完成）

- 2026-08-15：从参考实现 [cc1252/deepseek-harness-desktop](https://github.com/cc1252/deepseek-harness-desktop) @ main 拉取 tar.gz 并解包落地（29 个文件：main.js/preload.js/shell.html/package.json(+lock)/harness/package.json(+lock)/scripts/…/.github/…），harness 无 node_modules/runtime（符合预期）。
- 仓库：`deepseek-harness-desktop`（本机独立 git 仓库）。初始骨架提交 `bd7a7da`（main），切出工作分支 `feature/windows-mvp`。
- ✅ 1.1 验收通过：`npm run check` → `Source verification passed.`（verify-source.mjs 断言 electron 43.4.0 / @deepseek-ai/dsh 0.1.0-rc.6 / allowScripts 清单 / win.signExecutable=false / nsis.allowToChangeInstallationDirectory=false 全部匹配）。
- 下一步：1.2 `npm run setup`（prepare-runtime.ps1：harness `npm ci --omit=dev` + Node 24.19.0 下载校验 + 图标 + 第三方声明）。

## M2 — 1.2 运行时准备（完成）

- ✅ `npm run setup` 成功：harness `npm ci --omit=dev --no-audit --no-fund`（528 包，14s，含 node-pty/koffi 等 install 脚本，本机无编译失败——风险 6 实证不阻塞）；**Node v24.19.0 下载并 SHA-256 校验通过**（`57F71AB3652E797D84ACDDDC79C81CC9FF1C6DDB2A1974CDB83F00FEE9BFF4C73` 与固定值一致）；`build/deepseek-harness.svg` 图标复制；第三方声明 `build/THIRD_PARTY_LICENSES.txt`（523 包）。
- ✅ 1.2 验收全绿：`harness/runtime/node.exe --version` = v24.19.0；`@deepseek-ai/dsh/lib/bin.js` 存在且 `--help` 正常；runtime 含 node.exe/NODE-LICENSE.txt/SHASUMS256.txt。
- 下一步：根目录 `npm ci`（electron 43.4.0 + electron-builder 26.15.3）→ 1.3 `npm start`。
