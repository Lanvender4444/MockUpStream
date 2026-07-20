# 局域网/公网访问 + 身份验证 + 控制台改版

日期：2026-07-20

## 背景

MockUpStream 目前监听 `0.0.0.0`（Bun 默认），控制台页面（`/`）和所有管理接口（`/__*`）完全开放，没有任何身份验证。要让同事通过局域网或公网访问控制台来共同使用/调试这个假上游，必须先补上认证，否则任何能碰到端口的人都能改模型行为、看请求记录、清空配置。

同时控制台本身（`panel.html`）UI 比较拥挤（一列纵向堆叠的卡片），需要顺带做可用性上的整理，并加入"当前能通过什么地址访问"的网络信息展示。

## 范围

**保护对象**：控制台页面 `/` 和全部 `/__*` 管理接口。
**不保护**：`/v1/chat/completions`、`/v1/messages`、`/v1beta/models/*:generateContent` 等 mock 上游 API——这些是 new-api 侧内部调用的假上游端点，本身返回的就是假数据，且需求里明确只要求保护控制台/管理面。

## 认证模型

### 配置存储

新增 `authConfig`，存进现有 SQLite（`store.js` 新表 `auth`，单行）：

```
{ passwordHash: string|null, trustedIpsRegex: string|null, updatedAt: string }
```

- `passwordHash` 用 `Bun.password.hash()`（bcrypt），不存明文。
- 面板新增"网络与安全"区块，可以直接设置/修改密码、设置信任 IP 正则，即时落库，不需要重启进程。
- 环境变量作为**可选的启动引导/强制覆盖**：
  - `MOCK_ADMIN_PASSWORD`：若设置，每次启动都会用它重新计算 hash 并覆盖 DB 中的密码（用于 docker-compose 一次性配好，或密码忘记时改环境变量重启来重置）。
  - `MOCK_TRUSTED_IPS`：若设置，每次启动覆盖 DB 中的信任正则。
  - 都不设置时，完全以 DB（面板里改的）为准。

### 请求放行逻辑（伪代码）

```
authConfig = store.getAuthConfig()
if (!authConfig.passwordHash) {
  // 未设置过密码：现状不变，完全开放
  allow()
}
ip = getClientIp(req)              // 优先 Bun 连接层地址，不盲信 X-Forwarded-For
trustedPattern = authConfig.trustedIpsRegex
  ? new RegExp(authConfig.trustedIpsRegex)
  : DEFAULT_PRIVATE_IP_REGEX       // 127./10./172.16-31./192.168./::1 等
if (trustedPattern.test(ip)) {
  allow()                          // 信任 IP 直接放行，不需要 session
}
if (hasValidSession(req)) {
  allow()
}
redirectToLogin() // 或对 API 请求返回 401 JSON
```

要点：
- `MOCK_TRUSTED_IPS`/DB 里的自定义正则是**替换**默认私网正则，不是叠加——公网场景下如果还想让办公室同事免登录，正则要把局域网网段也写进去。
- IP 提取用 Bun `server.requestIP(req)`，不信任可伪造的 `X-Forwarded-For`；教程里会说明反向代理场景下的注意事项。

### 登录 / Session

- `POST /__auth/login`：body `{ password }`，用 `Bun.password.verify` 校验。成功后生成随机 token（`crypto.randomUUID()` 或等价），存进内存 `Map<token, {createdAt}>`，种 `httpOnly` cookie（`SameSite=Lax`）。
- `POST /__auth/logout`：清 cookie + 内存记录。
- Session 只存内存，服务重启后全部失效，需要重新登录——用换取实现简单，可接受。
- `GET /__auth/status`：返回 `{ passwordSet, authenticated, trustedByIp }`，供前端判断展示登录页 / 网络与安全区块的状态提示。
- `POST /__auth/config`：登录态（或信任 IP）下才能调用，body `{ password?, trustedIpsRegex? }`，更新 DB。`password` 为空字符串表示不改。

### 限流（防爆破）

- 登录接口按来源 IP 计数：内存 `Map<ip, {fails, lockedUntil}>`。
- 连续失败 5 次 → 锁定该 IP 15 分钟（期间直接 429，不再校验密码）。
- 登录成功清空该 IP 的计数。
- 因为信任 IP 根本不会打到登录接口，限流天然只影响非信任来源（一般是公网）。
- 计数纯内存，重启清零。

## 控制台前端改版

现状问题：所有区块（预设一键套用、预设管理、模型配置、最近请求）纵向堆成一列，找东西要一路滚动，新增"网络与安全"内容后会更挤。

改版方案（不引入新前端依赖，继续用现有 Alpine.js + 内联 CSS）：

1. **主区加 Tab 导航**：`模型配置`（含预设一键套用）/ `预设管理` / `最近请求` / `网络与安全`，一次只显示一个 tab，减少纵向滚动，视觉上更分区。
2. **左侧模型列表不变**，仍是常驻侧栏。
3. **新增"网络与安全" tab**，包含：
   - 当前访问地址：本机 `http://localhost:{PORT}`、自动探测到的局域网地址（Bun/Node 兼容的 `os.networkInterfaces()`，取非内部 IPv4），每条带复制按钮。
   - 公网访问的静态指引文字（端口转发/反向代理/HTTPS 建议），不做外部探测（不请求第三方服务获取公网 IP，避免额外外部依赖和隐私顾虑）。
   - 密码设置表单：新密码输入框 + 保存；未设置密码时旁边有明显提示"未启用密码保护，任何能访问此页面的人都可以修改所有配置"。
   - 信任 IP 正则输入框，带默认值说明和示例。
   - 当前认证状态展示（是否已启用密码 / 当前连接是否因信任 IP 免登录 / 登出按钮）。
4. **登录页**：独立、极简的服务端内联 HTML（不用 Alpine），一个密码框 + 提交按钮，失败展示错误信息（含"已锁定，请 N 分钟后再试"这种限流反馈）。
5. 视觉上做轻量整理（间距、卡片层次、字号），不做大改版重设计。

## 涉及文件

- `store.js`：加 `auth` 表读写（`getAuthConfig` / `setAuthConfig`）。
- `server.js`：
  - 认证中间件（IP 信任判断 → session 校验 → 放行/跳转/401）应用到 `/` 和所有 `/__*`（`/__auth/*` 自身的 login/status 端点除外）。
  - 限流 Map、session Map。
  - `/__auth/login`、`/__auth/logout`、`/__auth/status`、`/__auth/config` 路由。
  - 局域网 IP 探测（`os.networkInterfaces()`）用于 `/__state` 或新端点返回给前端展示。
  - 启动时读取 `MOCK_ADMIN_PASSWORD` / `MOCK_TRUSTED_IPS` 覆盖 DB。
- `panel.html`：登录页 HTML、Tab 导航改版、"网络与安全" 区块、Alpine `app()` 加认证状态/登录登出/网络信息相关逻辑。
- 不改 `formats/*`、`usage.js`、mock 上游路由本身、`presets.js`。

## 测试计划

新增 `auth.test.js`（bun test，风格参照现有 `formats.test.js`）：

- 未设密码：`/` 和 `/__state` 直接 200，无需任何 header。
- 设了密码、非信任 IP、无 session：`/__state` 返回 401（API 场景），`/` 重定向到登录。
- 信任 IP（默认私网正则命中 127.0.0.1）：直接放行，不需要 session。
- 自定义 `trustedIpsRegex` 后，未命中的 IP（包括原本免登录的私网段）要求登录——验证"替换而非叠加"的语义。
- 密码正确登录后拿到的 session cookie 能访问 `/__state`；登出后同一 cookie失效。
- 连续 5 次错误密码后第 6 次直接 429（不再校验密码本身），且返回信息里说明锁定剩余时间。
- 登录成功清空该 IP 失败计数（验证不会"以前失败过就一直半锁"）。

## 明确不做的事

- 不做多用户账号体系（沿用"共享密码"模型，用户已确认接受）。
- 不给 `/v1/*` mock 上游 API 加认证。
- 不自动探测/展示公网 IP（不引入外部依赖）。
- 不做"记住我"式长期 token、不做密码强度校验——单人/小团队共享密码场景下不必要。
