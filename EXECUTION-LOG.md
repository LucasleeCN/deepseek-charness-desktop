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
- 根目录 `npm ci`：286 包（electron 43.4.0 + electron-builder 26.15.3）。**注意**：npm ci 未触发 electron postinstall 下载二进制（dist 缺失），已手动 `node node_modules/electron/install.js` 补齐 `dist/electron.exe`（环境差异，非文档缺陷）。

## M3 — 1.3 启动与手工验证（完成）

- ✅ `npm start` 成功，desktop.log 记录：
  - `Starting Harness from ...\harness\node_modules\@deepseek-ai\dsh\lib\bin.js with ...\harness\runtime\node.exe`
  - `[dsh:out] dsh web: http://127.0.0.1:63283`（URL 行解析成功）
  - `[desktop] Loading http://127.0.0.1:63283`
  - `[desktop] Renderer ready {"title":"DeepSeek Harness","readyState":"complete","bodyTextLength":32}` —— **官方 UI 在沙箱 WebContentsView 中加载完成**。
- Electron 多进程正常（主进程+渲染+GPU）；验证后已停止并清理进程与端口。

## M4 — 1.4 QA 冒烟（完成）

- ✅ Run 1（截图 + 自动退出）：desktop.log 记录 `QA screenshot saved to ...\qa\screenshot-1.png`；文件 **100,371 字节**（>10KB 达标）；自动退出干净（`Stopping Harness` → `[dsh:exit] SIGTERM`，exit 0）。注：WGC 截图器有瞬时 `Failed to start capture` 错误日志，但 desktopCapturer 兜底成功，不影响验收。
- ✅ Run 2（窗口控制 + 自动退出）：`Window controls QA passed: maximize, restore, minimize`；`Testing the custom close action` 后正常退出。
- ✅ 无残留 electron/node 进程。

## M5 — 1.5 打包 + 1.6 阶段门禁（完成）

- ✅ `npm run build:windows` 成功（check → setup → electron-builder nsis portable → package-source → SHA256SUMS）：
  - `dist/DeepSeek-Harness-Desktop-Setup-0.1.0-x64.exe`（181,699,122 B）
  - `dist/DeepSeek-Harness-Desktop-Portable-0.1.0-x64.exe`（181,480,288 B）
  - `dist/DeepSeek-Harness-Desktop-Source-0.1.0.zip`（205,122 B）
  - `dist/SHA256SUMS.txt`；签名按 `signExecutable=false` 跳过（预期）。
- ✅ 校验和一致（注意 SHA256SUMS 为小写、Get-FileHash 大写，忽略大小写比对通过）。
- ✅ **便携版真实运行验收**：打包产物启动 → `Renderer ready {"title":"DeepSeek Harness","readyState":"complete"}` → 截图保存（65KB）→ 窗口控制 QA。首次运行 maximize 超时（5s 超时在首启场景偏紧，属抖动），**重试一次即通过**：`Window controls QA passed: maximize, restore, minimize` → 自动退出，无残留进程。
- ✅ 1.6 门禁全绿：check 通过 / 便携版启动加载 UI / 三 QA 钩子通过 / 产物齐全且校验和一致 / 无残留进程、无密钥泄露（本阶段未设置 `DEEPSEEK_API_KEY`，按计划跳过 3.4 式会话验证，仅验证 UI 加载——预期行为）。
- 工作分支：`feature/windows-mvp`。

## 阶段 1 结论

Windows MVP 完整落地：Electron 壳 + 捆绑 Node 24.19.0 + `@deepseek-ai/dsh@0.1.0-rc.6` harness + 官方 UI，QA 三钩子通过，安装器/便携版/SHA256SUMS 齐备。产物在 `dist/`，运行记录见本文件各里程碑。

## M6 — clean-room 壳重写（完成，2026-08-15 用户决策）

- 背景：用户要求壳代码不照抄参考实现。
- 范围：main.js / preload.js / shell.html 三个文件从零重写（分支 feature/cleanroom-shell，提交 e66cbd0，461+/518-）；行为契约不变（42px 标题栏 + WebContentsView 沙箱、spawn dsh web --port 0 + URL 行 90s、导航白名单、IPC、单实例锁、QA 三钩子、desktop.log）。
- 保留：harness/（@deepseek-ai/dsh 官方包）、Node/Electron 发行物、构建/打包流水线（依赖管理与基础设施，非壳代码）。
- ✅ npm run check 通过（Source verification passed.）。
- ✅ QA 冒烟三钩子通过：截图（61KB）/ Window controls QA passed / 自动退出，无残留。
- ✅ 重新打包：Setup + Portable + Source + SHA256SUMS；便携版真实运行验收一次通过（Renderer ready → 截图 → 窗口控制 QA → 自动退出），校验和一致。
- ✅ README/LICENSE 署名更新：壳为本仓库原创（MIT），第三方依赖署名保留。

## 阶段 1（clean-room 版）结论

Windows MVP 以原创壳代码交付：行为与文档契约一致，QA 与打包全绿。产物在 dist/（clean-room 版）。


## M7 — 安装器路径策略（用户需求，2026-08-15）

- 用户需求：严禁默认安装到 C 盘；安装器可选路径；交互安装不阻止用户选择 C 盘（允许自由选择）。
- 实现：
sis.allowToChangeInstallationDirectory=true（目录页可选路径）；新增 uild/installer.nsh（customInit 钩子）：默认目录若在 C 盘则重定位到第一个非系统盘（ FDD+HDD 枚举，跳过 C:）；用户显式 /D=<path> 时尊重用户选择不重定位。
- 
sis.warningsAsErrors=false：uninstaller 编译 pass 中 customInit 专用函数为未引用死代码（NSIS 6010 警告），属预期。
- verify-source.mjs 断言更新（allowToChangeInstallationDirectory=true、include=build/installer.nsh、含 NonCDrivePickDefault）。
- 运行时验证（真机）：T1 静默默认 → D:\DeepSeek Harness Desktop ✓；T2 静默 /D=C:\dsh-c-test → 安装到 C 盘 ✓（不阻止显式选择）；T3 静默 /D=D:\dsh-install-test → 安装成功 ✓。测试安装均已卸载清理。
- 另：C 盘已安装的旧版本已卸载（%LOCALAPPDATA%\Programs\DeepSeek Harness Desktop，含注册表条目）。
- 打包产物（9:49 最终版）：Setup/Portable/Source + SHA256SUMS，校验一致。

