# DeepSeek Harness Desktop

[English](README.en.md)

一个完整开源的 **DeepSeek Harness 非官方桌面客户端**，覆盖三端：

| 端 | 形态 | 状态 |
| --- | --- | --- |
| Windows | Electron 安装器 + 便携版 | ✅ 已交付 |
| macOS | Electron `.dmg`（x64 / arm64，ad-hoc 签名） | ✅ 代码与 CI 就绪，dmg 在 macOS/CI 上产出 |
| HarmonyOS | DevEco ArkTS 瘦客户端（ArkWeb 加载局域网宿主） | ✅ 工程就绪，真机/模拟器构建验证 |

桌面端启动官方 `@deepseek-ai/dsh` 本地 Web 服务，再用隔离的 Electron
`WebContentsView` 加载官方界面；桌面壳只负责进程生命周期、窗口、安全导航和自绘标题栏。
HarmonyOS 端不捆绑运行时，通过局域网连接运行在你自己电脑上的 `dsh web` 宿主。

> [!IMPORTANT]
> 本项目不是 DeepSeek 官方产品，也不提供模型额度或绕过 API 鉴权。
> DeepSeek Harness 仍处于 Developer Preview，请勿在高权限模式下打开不可信项目。

![DeepSeek Harness Desktop](docs/screenshot.png)

## 当前锁定版本

| 组件 | 版本 |
| --- | --- |
| DeepSeek Harness (`@deepseek-ai/dsh`) | `0.1.0-rc.6` |
| Electron | `43.4.0` |
| 内置 Node.js | `24.19.0` |
| electron-builder | `26.15.3` |

版本被明确锁定在两个 `package-lock.json` 中。`npm run setup` 从 Node.js 官方站点下载运行时，
并在解压前同时比对仓库内固定值和官方 `SHASUMS256.txt`（Windows x64 与 macOS
arm64/x64 三种归档都已固定 SHA-256）。

## 从源码运行

要求：Node.js 24、npm、git。

### Windows

另需 PowerShell 5 或更高版本。

```powershell
git clone <本仓库地址>
cd deepseek-harness-desktop
npm ci
npm run setup
npm start
```

`npm run setup` 会：

1. 按 `harness/package-lock.json` 安装官方 Harness 及其完整运行依赖；
2. 下载并校验当前平台的官方 Node.js 运行时；
3. 从 Harness npm 包提取官方鲸鱼图标；
4. 生成所有随包 npm 依赖的第三方许可证清单。

### macOS

另需 Node.js 24 与 Xcode Command Line Tools（`xcode-select --install`；
`node-pty` 等原生模块编译与 electron-builder 打包都需要）。

```sh
git clone <本仓库地址>
cd deepseek-harness-desktop
npm ci
npm run setup
npm start
```

首次在 macOS 上跑 QA 截图钩子时，系统会请求“屏幕录制”权限；不授权则截图 QA 按
计划记录为跳过（`desktop.log` 中 `macOS screen capture unavailable`），不影响窗口控制 QA。
如 GitHub 下载 Electron 超时，可用镜像后重跑：
`export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

## 构建发布包

### Windows

```powershell
npm ci
npm run build:windows
```

生成结果位于 `dist/`：

- 标准 NSIS 安装包；
- 便携单文件；
- `win-unpacked/` 快速启动目录；
- 源码快照与 `SHA256SUMS.txt`。

安装包没有商业代码签名，因此 Windows 可能显示“未知发布者”。
**安装路径策略（自 2026-08-15 起）**：安装器允许选择安装目录；**默认安装到第一个非系统盘**
（D:、E:、F:、G: 中第一个存在的盘），交互安装可选择任意路径。该策略由 `build/installer.nsh`
强制执行，并由 `npm run check`（verify-source.mjs）把关。

### macOS

在 Mac 上（本机架构自动识别，可用 `ARCH=x64` 或 `ARCH=arm64` 覆盖；
`ARCH` 会同步传给内置 Node 运行时的下载流程，避免架构错配）：

```sh
npm ci
npm run build:mac        # = scripts/build.sh
```

生成 `dist/DeepSeek-Harness-Desktop-<版本>-<架构>.dmg` 与 `dist/SHA256SUMS-mac.txt`。
脚本对 `.app` 做 ad-hoc 签名，并用签名后的 app 重建 dmg。首次打开：

1. 挂载 dmg，把 `DeepSeek Harness Desktop` 拖入 `/Applications`；
2. **右键 → 打开**（首次会因 Gatekeeper 隔离提示一次）；
3. 之后可正常启动。

一键验证（包含 QA 冒烟 + 打包 + 签名 + 挂载验证）：

```sh
bash scripts/verify-macos.sh
```

CI：`.github/workflows/macos-release.yml` 在 `macos-15`（arm64）与 `macos-15-intel`
（x64）两个 runner 上分别产出各自架构的 dmg；推 tag `v*` 时随 Windows 产物一起创建
GitHub Release。CI 中截图 QA 因无屏幕录制权限按计划跳过，只跑窗口控制 QA。

## HarmonyOS 瘦客户端

### 拓扑

```text
你自己的 PC（Windows/macOS）               HarmonyOS 设备（真机/模拟器）
┌─────────────────────────────┐           ┌──────────────────────────┐
│ dsh web 绑定 0.0.0.0:8080   │  局域网    │ DevEco 工程 harmonyos/   │
│ 官方 UI + 工具运行时         │ ────────▶ │ ArkWeb 加载 http://<PC-IP>:8080 │
└─────────────────────────────┘           └──────────────────────────┘
```

鸿蒙端只是瘦客户端：会话、工具、模型调用全部发生在宿主机上。

### 宿主部署（必读）

**CLI 故意拒绝 `dsh web --host 0.0.0.0`**（安全设计），绑定非 loopback 只能通过
profile 用户层补丁。假设用 8080 端口：

1. 创建 `$DSH_HOME/profiles/web/cordis.patch.yml`（Windows 默认
   `%USERPROFILE%\.dsh`，macOS 默认 `~/.dsh`）：

   ```yaml
   - id: webserver
     config:
       host: 0.0.0.0
       port: 8080
   ```

2. 启动（**不要**传 `--host`）：

   ```sh
   dsh web
   # 输出形如：dsh web: http://127.0.0.1:8080 (LAN: http://<PC-IP>:8080)
   ```

3. 放行防火墙（Windows 入站规则 / macOS 防火墙）并以真实局域网 IP 为准
   （URL 行的 LAN 地址可能取到 WSL/虚拟网卡 IP）。

4. **验收**：先用同一局域网手机浏览器访问 `http://<PC-IP>:8080`，加载官方 UI
   **并完成一次真实会话**（新建会话 → 提问 → 看到回复）。仅页面加载不算通过。
   绑定 `0.0.0.0` 时 `/api` 信任围栏会自动信任局域网 IPv4 字面量；若改用主机名访问，
   必须追加 `dsh web --trusted-host <host[:port]>`。

> [!WARNING]
> `dsh web` 无 TLS、无认证。绑定 `0.0.0.0` 等于把 Harness 暴露给所在网络，
> 只应在可信局域网使用，用完请恢复默认 `127.0.0.1`。

### 构建与运行鸿蒙端

1. 用 DevEco Studio 6.x 打开本仓库 `harmonyos/` 目录（Stage 模型 + ArkTS）。
2. 首次打开如提示 SDK/API 版本不一致，在 `build-profile.json5` 的
   `compatibleSdkVersion` 改为你本机已安装的 API（工程默认 `5.0.0(12)`）。
3. 用华为账号登录 DevEco，真机打开“自动签名”（免费），或使用本地模拟器。
4. 运行后输入宿主地址（默认 `http://192.168.1.100:8080` 占位，请改成实际 IP），
   点击“连接”。地址会持久化，下次启动自动加载；断线显示错误页，可一键重连。
5. **验收**：完成一次真实会话（新建会话 → 提问 → 看到回复流式渲染）。

明文 HTTP 是路径 A（MVP）。按 2026-08 官方文档核验，Stage 模型没有
`network.cleartextTraffic` 之类的 module.json5 配置，ArkWeb 加载纯 HTTP 页面
只需 INTERNET 权限；工程已设置 `.mixedMode(MixedMode.All)` 应对混合内容拦截。
若真机仍报 `net::ERR_CLEARTEXT_NOT_PERMITTED`，按 `harmonyos/README.md` 走
路径 B（https + mkcert 自签证书 + 反代）。两条路径都必须以真实 `/api` 交互通过为准。

详见 [`harmonyos/README.md`](harmonyos/README.md)。

## 结构

```text
.
├─ main.js                         Electron 主进程、Harness 子进程和内容视图
├─ preload.js                      最小权限窗口控制桥
├─ shell.html                      自绘标题栏和启动画面
├─ build/
│  ├─ deepseek-harness.svg         官方 Harness 包中的鲸鱼图标
│  ├─ icon.png / icon.icns         macOS 图标（由脚本从 SVG 生成并提交）
│  └─ installer.nsh                Windows 安装路径策略
├─ harness/                        官方 CLI 的独立运行时依赖与锁文件
├─ scripts/
│  ├─ prepare-runtime.mjs          跨平台运行时准备（npm run setup）
│  ├─ prepare-runtime.ps1          旧 Windows 入口（保留兼容）
│  ├─ generate-icons.mjs           从 SVG 生成 PNG/ICNS（复用 harness 依赖，无需新增包）
│  ├─ build-windows.ps1 / build.sh  Windows / macOS 一键构建
│  ├─ verify-macos.sh              macOS 端到端验收脚本
│  └─ verify-source.mjs            源码与打包策略把关（npm run check）
├─ harmonyos/                      HarmonyOS DevEco 瘦客户端工程
├─ dist/                           各平台构建产物
└─ .github/workflows/              Windows / macOS Release 与源码检查
```

架构细节参见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## API Key 与数据

应用会继承启动进程的环境变量，因此已有 `DEEPSEEK_API_KEY` 时可以直接使用。
也可以在 Harness 左下角的“设置”→“Models”中配置供应商。本项目不保存、上传或内置 API Key。

桌面端用户数据和日志：

```text
Windows: %APPDATA%\deepseek-harness-desktop\harness-home
         %APPDATA%\deepseek-harness-desktop\logs\desktop.log
macOS:   ~/Library/Application Support/deepseek-harness-desktop/harness-home
         ~/Library/Application Support/deepseek-harness-desktop/logs/desktop.log
```

Harness 进程的默认工作区为 `<userData>/harness-home/workspace`（不会以整个
用户主目录作为工作根目录）；如需访问其他目录，在 Harness UI 的目录选择器中
显式选择即可。

鸿蒙端只持久化“宿主 URL”一项设置，不保存会话数据。

## 安全边界

- 桌面端 Harness 服务只监听 `127.0.0.1` 的随机端口；
- Harness 子进程的默认工作区被限制在 `<userData>/harness-home/workspace`，
  不继承用户主目录；
- 官方页面运行在 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false` 的内容视图中；
- 自绘标题栏只能通过受限 IPC 请求最小化、最大化/还原和关闭；
- 非本地导航交给系统浏览器，不允许页面直接访问 Node.js；
- 单实例退出时同步停止 Harness 子进程；
- 鸿蒙宿主绑定 `0.0.0.0` 是显式、可逆的用户配置（profile 补丁），非默认行为。

## 上游、图标和许可证

桌面壳（`main.js` / `preload.js` / `shell.html` 与构建脚本）为本仓库**原创实现**，采用
[MIT License](LICENSE)。DeepSeek Harness 及官方鲸鱼图标归 [deepseek-ai](https://github.com/deepseek-ai) 所有，
按其 MIT 许可证使用和署名；本壳所依赖的 `@deepseek-ai/dsh`、Electron、Node.js 均为第三方发行物，
各自许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

- Harness 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- Electron：[electron/electron](https://github.com/electron/electron)
- Node.js：[nodejs/node](https://github.com/nodejs/node)

## 贡献

欢迎 Issue 和 Pull Request。提交前请运行：

```sh
npm ci
npm run check
```

参见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)。
