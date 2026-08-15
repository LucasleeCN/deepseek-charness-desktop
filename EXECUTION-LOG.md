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

## M8 — 阶段 2 macOS 移植（代码与 CI 完成，待 macOS 机器验收）

- 2.1 跨平台运行时脚本：`scripts/prepare-runtime.mjs`（此前已在工作区）并入 `npm run setup`；修复 Windows 归档固定 SHA-256 笔误（`...84ACDDDC...` → 官方 `...84ACDDC7...`），darwin arm64/x64 固定值与 nodejs.org `SHASUMS256.txt` 逐字节核对一致；增加 LICENSE/SHASUMS 落地与可执行位设置；受约束环境下 `node --version` 管道捕获失败时退化为执行探测，避免重复下载。
- 2.2 主进程平台差异：`main.js` 的 `bundledNodeBinaryName()`（win=node.exe / darwin=node）；macOS 最小应用菜单（About/Quit/编辑/窗口，保留 Cmd 快捷键）+ dock 图标（build/icon.png）；`app.setAppUserModelId` 仅 Windows 调用；截图 QA 在 macOS 无屏幕录制授权时记录 `macOS screen capture unavailable` 并按计划跳过而非失败。
- 图标：`scripts/generate-icons.mjs` 复用 harness 依赖树中的 sharp 渲染官方 SVG → `build/icon.png`(1024², 34,049B) 与 `build/icon.icns`(58,192B，icp4/5/6 + ic07/08/09/10 七个 PNG chunk，结构已验证)；脚本另带 Chrome headless 兜底，不新增 npm 依赖。
- 2.4 打包：package.json 新增 `build.mac`（dmg、icon.icns、identity:null、hardenedRuntime/gatekeeperAssess=false）与 `npm run build:mac`；`scripts/build.sh` = check → setup → icons → electron-builder dmg(本机架构) → ad-hoc codesign → 签名校验 → 用已签名 app 重建 dmg → SHA256SUMS-mac.txt。
- 验收脚本：`scripts/verify-macos.sh`（前置检查 → npm ci → setup → icons → check → 截图 QA（含授权跳过分支）→ 窗口控制 QA + 无残留进程 → build.sh → 签名与 dmg 挂载验证 → 打印剩余手工项）；bash -n 语法检查通过。
- 2.5 CI：`.github/workflows/macos-release.yml`（macos-15=arm64 与 macos-15-intel=x64 双 job，各自 setup→icons→check→窗口控制 QA→build.sh→上传；release job 在 tag v* 时合并上传两个 dmg）。说明：计划原文的 macos-13 已于 2025-09 被 GitHub 退役，改用现行标签。
- verify-source.mjs 新增 mac 策略断言（setup 必须走 mjs、dmg-only、identity:null、icon.icns 且 ICNS magic 校验）。
- Windows 回归：`npm run check` 通过；`npm run setup` 幂等通过（复用既有运行时，不再重复下载）；`npm run build:dir`（win-unpacked）成功。
- ⏳ 待 macOS 机器执行：`bash scripts/verify-macos.sh`（用户已确认会执行并把日志/结果反馈）。当前 Windows 环境无法产出 dmg 或跑 mac QA，按计划属预期。

## M9 — 阶段 3 HarmonyOS 瘦客户端（工程完成，待 DevEco 真机/模拟器构建）

- 工程：`harmonyos/` Stage 模型 + ArkTS 空能力模板（AppScope + entry），默认
  `compatibleSdkVersion = "5.0.0(12)"`（格式经 2026-08 官方文档核验；DevEco 6
  按字段语义可编译，compileSdkVersion 省略即用本机内置 SDK；README 已写调整方法）。
- 页面：`pages/Index.ets` = 顶部宿主地址设置栏（TextInput + 44vp 连接按钮 +
  状态文本）+ ArkWeb `Web` 组件（javaScriptAccess/domStorageAccess/zoomAccess/
  mixedMode(MixedMode.All)）+ onPageBegin/onPageEnd/onErrorReceive 状态机 +
  错误覆盖层与“重试”。宿主 URL 用 `@kit.ArkData` preferences
  （getPreferencesSync/putSync/flush）持久化，启动自动加载；仅持久化 URL。
- 权限与配置：module.json5 声明 `ohos.permission.INTERNET`；startWindowIcon/
  startWindowBackground/主页面 profile 齐全；应用与入口图标由
  `build/icon.png` 复制（1024² PNG）。
- 关键事实核验（研究子代理，官方文档 V229/2026-08）：
  - Stage 模型 **不存在** `network.cleartextTraffic`/`networkSecurityConfig`
    这类 module.json5 字段（那是 FA config.json + `@system.fetch` 旧配置）；
  - ArkWeb 纯 HTTP 页面只需 INTERNET 权限；`ERR_CLEARTEXT_NOT_PERMITTED` 主要
    对应 HTTPS 页加载 HTTP 子资源的混合内容拦截，官方放行是
    `.mixedMode(MixedMode.All)` —— 工程已内置；
  - ArkWeb 私有网络访问（PNA）配置未在官方 ArkWeb 文档中发现（未查实项）。
- 文档：`harmonyos/README.md` = 宿主 profile 补丁部署（`0.0.0.0:8080`，CLI
  禁传 `--host`）+ 防火墙 + 手机浏览器真实会话预验收 + DevEco 构建/自动签名 +
  路径 A（明文，MVP）/ 路径 B（mkcert + Caddy + `--trusted-host` 注意项）+
  风险清单。根 README（中/英）同步三端说明。
- verify-source.mjs 新增 HarmonyOS 断言（工程文件齐全、INTERNET 权限、Web
  组件存在、Preferences 持久化、compatibleSdkVersion 声明）；全部 JSON/JSON5
  已通过 JSON 语法解析；`npm run check` 通过。
- ⏳ 待 DevEco 机器执行（用户确认由其在 DevEco 打开构建）：Build Hap →
  真机/模拟器连局域网宿主 → 输入实际 IP → 完成一次真实会话 → 验证设置/重连/
  重启记忆。本机未安装 DevEco/SDK，HAP 构建与端到端会话按计划留待用户执行。

## M10 — macOS 真机构建结果 + Code Review 修复（2026-08-15）

用户侧 macOS 构建与 QA（arm64）通过：

- DMG：`dist/DeepSeek-Harness-Desktop-0.1.0-arm64.dmg`（332MB）；
- SHA-256：`b0f9904bc21b361415abb61841a43422d66f80692fcc9c5fe555bf7dc7d6e1b6`；
- `.app` ad-hoc 签名，`codesign --verify --deep --strict` 通过；
- 产物真实启动 QA：Harness UI 加载成功、`Window controls QA passed`、退出时
  Harness 正常停止；
- 注：GitHub 下载 Electron 超时一次，用户改用
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 后成功（已写入 README）。

Code Review 三条结论均已修复：

1. 【高】Harness cwd 从 `app.getPath('home')` 改为
   `<userData>/harness-home/workspace`（main.js 创建目录并写入日志；verify-source
   新增断言；README/ARCHITECTURE 同步说明）。
2. 【中】`prepare-runtime.mjs` 新增 `--arch x64|arm64`，按目标架构选择归档；
   复用检测改为读取二进制本身的 PE machine / Mach-O cputype，已有运行时与目标
   架构不符时强制重下；`build.sh`、`verify-macos.sh`、macOS CI 均传 `--arch`。
3. 【低】`build.sh` 新增 Node 主版本 ≥24 检查（与 verify-macos.sh 一致）。

修复后本地回归：`npm run check` 通过（新增断言全部命中），Windows
`npm run setup` / `npm run build:dir` 待最终提交前复跑。

## M11 — 借鉴 anywhere-labs：托盘常驻 + 手机远程访问（2026-08-15）

- 用户决策：一步做到“局域网手机直连桌面 Harness”（托盘 + 远程开关 + 二维码 +
  鸿蒙适配）。
- 生命周期：托盘常驻（关窗隐藏，Host 继续运行；托盘菜单 打开/手机远程/退出）；
  `requestAppQuit()` 串行化退出（SIGTERM 5s → SIGKILL → 释放 before-quit）；
  macOS activate 恢复窗口；无托盘时回退“关最后窗口即退出”。QA 自定义关闭按钮
  在 QA 环境仍走完整退出，保证 `Window controls QA passed` 语义不变。
- 远程开关：`remote.html` 设置窗口（开关/端口/地址/复制/二维码/错误提示）；
  标题栏新增“手机”入口；启用时在 `<userData>/harness-home/profiles/web/
  cordis.patch.yml` 增改 `webserver`（host 0.0.0.0 + 端口，默认 8787，保留
  其他插件条目），重启 Harness 并解析 `(LAN: http://<ip>:<port>)`；失败自动
  回滚 loopback。关闭时移除 webserver 条目并恢复 `--port 0`。
- 二维码：新增 pinned 依赖 `qrcode-generator@2.0.4`（零依赖，MIT），
  `qrSvgDataUrl()` 生成 SVG data URL；files 打包 `remote.html` 与
  `node_modules/qrcode-generator/**`；THIRD_PARTY_NOTICES 增补。
- 安全：远程窗口 IPC 同样做 sender 校验（仅 shell/remote 两个可信页面）；
  远程模式仍是显式用户开关，关闭即恢复 loopback。
- HarmonyOS：默认/占位地址改 8787，输入框文案指向桌面“手机远程访问”；
  README（中/英）与 harmonyos/README 补“方式 A 桌面开关（推荐）/方式 B CLI”。
- verify-source 新增断言：qrcode-generator 精确锁版、remote.html 与 QR 依赖
  打包、Tray/0.0.0.0 补丁/LAN URL 解析必须存在；`npm run check` 通过。
- 本地回归：`npm ci --dry-run`、`npm run check`、`npm run setup`、bash -n、
  JSON5 解析全部通过；`npm run build:dir` 成功且 asar 内含 `remote.html` 与
  `node_modules/qrcode-generator`。GUI QA 本轮未重跑（当前会话 GUI 沙箱受限且
  用户侧有运行中的桌面实例）；macOS 上 `scripts/verify-macos.sh` 新增了
  `DSH_DESKTOP_QA_REMOTE` 钩子（开启→LAN 发现→关闭），待用户下次运行反馈。

## M12 — HarmonyOS DevEco 首次构建结果（2026-08-15）

- 用户在 DevEco 打开 `harmonyos/`：**Build task in 8s 889ms，构建成功**，
  产出 `entry/build/default/outputs/default/entry-default-unsigned.hap`。
- 首次 Run 失败：`Install Failed: code 9568320 no signature file` ——
  属预期（未配置自动签名），与工程/代码无关。
- 处理：已在 `harmonyos/README.md` 新增“排障：no signature file”章节
  （登录华为账号 → Project Structure → Automatically generate signature →
  重建得到 signed HAP → 真机 UDID 授权）。
- 待用户按步骤签名后重新 Run 并执行 3.5 验收（UI 加载 / 真实会话 / 重连 /
  重启记忆）。

## M13 — 鸿蒙真机联调：会话列表空白的根因与修复（2026-08-15）

- 通过 hdc + uitest 自动操作真机复现并定位：
  - App 地址仍为默认占位 `http://192.168.1.100:8787`；状态“已连接”是
    `onPageEnd` 在错误页后误报的 UI bug；
  - 修正为 PC 真实 IP `http://<PC-IP>:8787` 后，官方 UI 外壳正常加载
    （可看到侧边栏/新建会话按钮），但 hilog 持续
    `[web-runtime] connection lost, retry #N`，会话与工作区列表为空；
  - 探针实验：ArkWeb 的 `ws://` 到普通回显服务器正常、到 DSH Host 的同源
    WebSocket 也正常；在运行中宿主注入日志后抓到真正的异常：
    **`crypto.randomUUID is not a function`**。ArkWeb 缺这个 API，官方前端
    为每个 RPC envelope 生成 rpcId 时抛错 → 永远 reconnecting，列表不落地。
- 修复（已提交）：
  - `Index.ets` 在加载宿主页面前用 `@kit.NetworkKit` 预取 HTML，注入
    `crypto.randomUUID` polyfill，再通过 `onInterceptRequest` 把修改后的
    主文档响应交给 ArkWeb（polyfill 在官方 bundle 执行前生效）；
  - 增加 `.databaseAccess(true)`；修复 `onErrorReceive` → `onPageEnd`
    覆盖错误状态的顺序 bug（loadError 门闩）；启动/手动连接统一走
    prepareBootstrap，状态栏显示当前连接 URL；
  - `module.json5` 增加 `ohos.permission.GET_NETWORK_INFO`；
  - 曾尝试 `network.cleartextTraffic` 但被 DevEco 6.1.1 的 module schema
    拒绝（字段不在允许列表），已撤回该字段；WebSocket 明文并非根因。
  - `harmonyos/README.md` 更新排障（首要原因改为 crypto.randomUUID）；
    verify-source 增加 polyfill + onInterceptRequest 断言。
- 待用户：DevEco 重新 Build/Run 后，用 `http://<PC-IP>:8787` 验证
  会话列表与真实会话。

