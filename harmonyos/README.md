# DeepSeek Harness Desktop — HarmonyOS 瘦客户端

本目录是可在 DevEco Studio 打开的 Stage 模型 ArkTS 工程。App 内用 ArkWeb
`Web` 组件加载宿主机上的 `dsh web`，鸿蒙端不捆绑任何运行时。

## 1. 宿主机准备（先做）

### 1a. 推荐：用桌面 App 的“手机远程访问”开关

在桌面客户端标题栏点“手机”（或托盘菜单 → 手机远程访问），开启“允许局域网
访问”。桌面端会自动：

1. 写入 `webserver` profile 补丁（`host: 0.0.0.0`，默认端口 **8787**）；
2. 重启本机 Harness 并显示局域网地址 + 二维码；
3. 关闭开关时恢复 `127.0.0.1`。

手机与电脑连同一局域网，用鸿蒙 App 扫码或手输地址即可。关闭桌面窗口不会
断开——Host 继续在系统托盘运行。

### 1b. 手动方式：独立 `dsh web` 宿主

**CLI 会拒绝 `dsh web --host 0.0.0.0`**，必须用 profile 用户层补丁让
webserver 绑定局域网。假设用 8080 端口：

1. 创建 `$DSH_HOME/profiles/web/cordis.patch.yml`：
   - Windows：`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`
   - macOS/Linux：`~/.dsh/profiles/web/cordis.patch.yml`

   ```yaml
   - id: webserver
     config:
       host: 0.0.0.0
       port: 8080
   ```

2. 启动 `dsh web`（不要传 `--host`）：

   ```sh
   dsh web
   # dsh web: http://127.0.0.1:8080 (LAN: http://<PC-IP>:8080)
   ```

3. 放行防火墙端口（桌面开关是 8787，CLI 示例是 8080），并确认 PC 的真实
   局域网 IP（URL 行里的 LAN 地址可能取到 WSL/虚拟网卡 IP，以
   `ipconfig` / `ifconfig` 为准）。

4. **围栏验收（必须）**：用同一局域网的手机浏览器访问该地址，加载官方 UI
   后**完成一次真实会话**（新建会话 → 提问 → 看到回复）。绑定 `0.0.0.0` 时
   `/api` 信任围栏自动信任 LAN IPv4 字面量；若改用主机名访问，宿主必须追加
   `dsh web --trusted-host <host[:port]>`。

> 风险：`dsh web` 无 TLS、无认证。`0.0.0.0` 会把 Harness 暴露给整个网络，
> 只在可信局域网使用，用完关闭桌面开关或把 profile 补丁改回 `host: 127.0.0.1`。

## 2. 用 DevEco Studio 打开与构建

1. 打开本目录（`harmonyos/`）作为工程。建议 DevEco Studio 6.x。
2. 工程默认 `compatibleSdkVersion = "5.0.0(12)"`（API 12）。如果你的机器
   只装了别的 API，把根 `build-profile.json5` 里该字段改成已安装版本
   （例如 `"5.0.5(17)"`、`"6.0.0(20)"`）。
3. 真机：登录华为账号 → File → Project Structure → Signing Configs →
   勾选 Automatically generate signature（免费自动签名）；模拟器：直接运行。
4. 菜单 Build → Build Hap(s) / APP(s)，或直接 Run。

工程权限已声明 `ohos.permission.INTERNET`，App 只持久化“宿主 URL”一项
（Preferences），无其他权限。

## 3. 运行与验收

1. 设备与宿主机连同一局域网。
2. 顶部输入宿主地址（桌面开关默认 `http://<PC-IP>:8787`，CLI 示例
   `http://<PC-IP>:8080`），点“连接”。
3. 地址会持久化，下次启动自动加载；断线时显示错误页并可“重试”。
4. **验收**：页面显示官方 UI；完成一次真实会话（新建会话 → 提问 → 看到
   回复流式渲染）；改地址能连到另一台宿主；断网重连成功；重启 App 记住地址。

## 4. 路径 A（明文 HTTP）与路径 B（HTTPS）验证

### 路径 A：IP 直连明文（MVP）

工程默认使用 `http://<PC-IP>:8787`（桌面远程开关的默认端口）。鸿蒙端做了
两件 ArkWeb 适配：

- `Index.ets` 在加载宿主页面前预取 HTML，并通过 `onInterceptRequest`
  注入 **`crypto.randomUUID` polyfill**（当前 ArkWeb 缺这个 API，而官方
  Web UI 的 RPC/WebSocket 建连依赖它；缺失时表现为页面能开但会话列表
  空白、日志反复 `connection lost, retry #N`）；
- 权限已声明 `ohos.permission.INTERNET` 与 `ohos.permission.GET_NETWORK_INFO`；
- Web 组件已设置 `.domStorageAccess(true)`、`.databaseAccess(true)`、
  `.javaScriptAccess(true)`、`.mixedMode(MixedMode.All)`。

验证步骤不变：页面加载 + 完成一次真实会话 → 路径 A 通过；失败则先看
`onErrorReceive` 的错误码（-29 即 CLEARTEXT_NOT_PERMITTED），确认宿主机与
防火墙后走路径 B。

### 路径 B：https + 自签证书 + 反代（加固）

1. 宿主机安装 [mkcert](https://github.com/FiloSottile/mkcert)，为局域网
   IP 生成证书（或用主机名）：
   ```sh
   mkcert -install
   mkcert 192.168.1.100        # 或 mkcert harness.lan
   ```
2. 用 Caddy 反代 `http://127.0.0.1:8080` 并终结 TLS。Caddyfile 示例：
   ```text
   https://192.168.1.100:8443 {
       tls 192.168.1.100.pem 192.168.1.100-key.pem
       reverse_proxy 127.0.0.1:8080
   }
   ```
3. **用主机名时必须给宿主加信任**：
   `dsh web --trusted-host harness.lan`（或 profile 的
   `trustedHosts`），否则 `/api` 被信任围栏拒绝。用 IP 字面量时围栏自动放行。
4. 设备信任自签 CA：把 `rootCA.pem` 导入设备（系统设置 → 安全 → 证书，
   或 DevEco 文档支持的方式）。HarmonyOS NEXT 对用户 CA 的信任策略可能
   不生效——若不生效，换 IP 字面量 + 设备级信任，或回退路径 A 并记录结论。
5. 把 App 内地址改为 `https://<IP或主机名>:8443` 并重复第 3 节验收。

两条路径的验收都必须完成真实 `/api` 交互，仅页面加载不算通过。

## 5. 排障：`Install Failed: no signature file (code 9568320)`

构建成功但 HAP 是 `entry-default-unsigned.hap`，真机拒绝安装。修复：

1. 登录华为账号：`File → Settings → Huawei Account`。
2. `File → Project Structure → Signing Configs` → 勾选
   **Automatically generate signature** → 按提示自动生成调试证书/Profile
   （bundleName 保持 `com.deepseek.harness.desktop`）→ Apply/OK。
3. 重新 `Build → Build Hap(s)/APP(s)`：输出应变为
   `entry-default-signed.hap`，Run 即可安装。
4. 真机需开启开发者模式/USB 调试，并加入华为账号的调试设备授权
   （Device Manager 或 DevEco 弹出的 UDID 注册提示）。

### 5.1 页面能开但会话列表空白：`connection lost, retry #N`

症状：官方 UI 外壳加载了，但会话/工作区列表为空，hilog 里反复出现
`[web-runtime] connection lost, retry #N`。

原因与处理（真机已定位）：

1. **首要原因：ArkWeb 缺少 `crypto.randomUUID`**。官方前端在建立
   RPC/WebSocket 通道时调用它；缺失时每次建连都失败并重连。本工程已在
   `Index.ets` 通过 `onInterceptRequest` 注入 polyfill，升级到该版本即可；
   改的是 ArkTS 代码，需要重新 Build/Run。
2. 确认 App 地址是 **PC 的真实局域网 IP**（如 `http://<PC-IP>:8787`），
   不是默认占位 `192.168.1.100`，也不是 `127.0.0.1`。
3. 在 PC 上验证宿主机：`netstat -ano | findstr 8787` 应显示
   `0.0.0.0:8787 LISTENING`。
4. 仍失败则走路径 B（https + wss），并记录设备 hilog 中的错误码。

## 6. 已知限制

- 宿主机 IP 变化后需在 App 里更新地址（不自动发现）。
- 官方 UI 的目录选择器等“坐在宿主机前”的交互在远端不可用；需要远端浏览时
  按 Harness 上游方案为 profile 组合 `directory-picker-browse`。
- ArkWeb 无法为页面内请求附加自定义认证头。当前方案依赖“可信局域网 +
  宿主机网络隔离”；若反代要求应用层令牌，只能选 URL query 令牌或
  `httpAuth`，需真实验证后记录（本工程默认不启用）。
