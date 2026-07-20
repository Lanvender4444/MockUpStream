# 局域网/公网访问身份验证 + 控制台改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 MockUpStream 的控制台（`/` + `/__*` 管理接口）加上共享密码 + Session 登录、信任 IP 免登录白名单、登录限流，配置存 SQLite 可在面板里改；同时把面板从一列纵向堆叠的卡片改成 Tab 布局，新增"网络与安全"区块展示局域网访问地址并暴露上述配置项。

**Architecture:** 新增 `auth.js`（纯函数，不依赖 store.js，靠参数传入配置，方便单测）负责 IP 信任判断/密码哈希/Session/限流；`store.js` 新增 `auth` 表持久化密码 hash 和信任正则；`server.js` 在路由分发最前面加一道认证网关，只挡 `/` 和 `/__*`，`/v1/*` 等 mock 上游 API 完全不受影响；`panel.html` 改 Tab 布局 + 新增安全设置表单。

**Tech Stack:** Bun（`bun:sqlite`、`Bun.password` 走 bcrypt、Web 标准 `crypto.randomUUID`、`os.networkInterfaces`）、Alpine.js（已有 vendor 文件，不加新依赖）、`bun:test`。

## Global Constraints

- 不引入任何新的 npm/外部依赖，只用 Bun 内置能力（`bun:sqlite`、`Bun.password`、全局 `crypto`、Node 兼容的 `os` 模块）。
- `MOCK_ADMIN_PASSWORD` / `MOCK_TRUSTED_IPS` 未设置环境变量、且 DB 里也没设置密码时，行为必须与现状完全一致（`/` 和 `/__*` 完全开放）——这是硬约束，任何一步都不能破坏纯本地开发的现有用法。
- 只保护控制台页面 `/`、`/index.html` 和所有 `/__*` 管理接口；`/v1/*`、`/v1beta/*` 等 mock 上游 API 端点不加任何认证。
- 自定义 `trustedIpsRegex` 替换默认私网正则，不是叠加。
- Session 只存内存（进程重启即失效），密码只存 bcrypt hash，不存明文。
- 登录接口限流：同一来源 IP 连续失败 5 次锁定 15 分钟；成功登录清空该 IP 计数。
- 不做多用户账号体系、不做密码强度校验、不自动探测/展示公网 IP。
- 代码风格跟随现有文件：中文注释，简洁，无多余抽象。

---

### Task 1: store.js — auth 配置持久化

**Files:**
- Modify: `store.js`
- Test: `auth.test.js`（新建）

**Interfaces:**
- Produces: `store.load(dbPath?)` — `dbPath` 可选，不传时用原来的 `mock.db` 路径，传 `":memory:"` 供测试用；`store.getAuthConfig()` → `{ passwordHash: string|null, trustedIpsRegex: string|null, updatedAt: string|null }`；`store.setAuthConfig(patch)` — `patch` 可含 `passwordHash`/`trustedIpsRegex` 任意子集，未传的字段保持原值，返回更新后的完整配置对象。

- [ ] **Step 1: 写失败的测试**

创建 `auth.test.js`：

```js
// auth.test.js —— bun test: 局域网/公网访问身份验证（store 持久化 + auth.js 逻辑）。
import { test, expect, beforeEach } from "bun:test";
import * as store from "./store.js";

beforeEach(async () => {
  await store.load(":memory:");
});

test("getAuthConfig: 初始状态密码和信任正则都是 null", () => {
  const cfg = store.getAuthConfig();
  expect(cfg.passwordHash).toBeNull();
  expect(cfg.trustedIpsRegex).toBeNull();
});

test("setAuthConfig: 写入密码 hash 后能读回", () => {
  store.setAuthConfig({ passwordHash: "fake-hash-value" });
  const cfg = store.getAuthConfig();
  expect(cfg.passwordHash).toBe("fake-hash-value");
  expect(cfg.trustedIpsRegex).toBeNull();
});

test("setAuthConfig: 写入信任正则后能读回, 不影响已设置的密码", () => {
  store.setAuthConfig({ passwordHash: "fake-hash-value" });
  store.setAuthConfig({ trustedIpsRegex: "^192\\.168\\." });
  const cfg = store.getAuthConfig();
  expect(cfg.passwordHash).toBe("fake-hash-value");
  expect(cfg.trustedIpsRegex).toBe("^192\\.168\\.");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test auth.test.js`
Expected: FAIL —— `store.getAuthConfig is not a function`（或类似 TypeError），因为 store.js 还没实现这几个导出。

- [ ] **Step 3: 实现 store.js 改动**

在 `store.js` 里，`function initSchema() {...}` 函数定义之后（第 80 行 `}` 之后）新增：

```js
function initAuthSchema() {
  db.run(`CREATE TABLE IF NOT EXISTS auth (id INTEGER PRIMARY KEY CHECK (id = 1), passwordHash TEXT, trustedIpsRegex TEXT, updatedAt TEXT)`);
  const row = db.query("SELECT id FROM auth WHERE id = 1").get();
  if (!row) db.run("INSERT INTO auth (id, passwordHash, trustedIpsRegex, updatedAt) VALUES (1, NULL, NULL, NULL)");
}
```

把 `export async function load() {` 整个函数替换成：

```js
export async function load(dbPath) {
  db = new Database(dbPath || DB_PATH);
  // 配置库写操作极少, 不用 WAL(避免强杀丢未 checkpoint 的提交);
  // 默认回滚日志 + synchronous FULL => 每次提交即时落盘, 抗强杀。
  db.run("PRAGMA synchronous = FULL");
  initSchema();
  initAuthSchema();
  seedIfEmpty();
  return getState();
}
```

在文件末尾（`export async function reset() {...}` 之后）追加：

```js
export function getAuthConfig() {
  const row = db.query("SELECT passwordHash, trustedIpsRegex, updatedAt FROM auth WHERE id = 1").get();
  return row || { passwordHash: null, trustedIpsRegex: null, updatedAt: null };
}

export function setAuthConfig(patch) {
  const cur = getAuthConfig();
  const next = {
    passwordHash: patch.passwordHash !== undefined ? patch.passwordHash : cur.passwordHash,
    trustedIpsRegex: patch.trustedIpsRegex !== undefined ? patch.trustedIpsRegex : cur.trustedIpsRegex,
    updatedAt: new Date().toISOString(),
  };
  db.run("UPDATE auth SET passwordHash = ?, trustedIpsRegex = ?, updatedAt = ? WHERE id = 1", [next.passwordHash, next.trustedIpsRegex, next.updatedAt]);
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test auth.test.js`
Expected: PASS（3 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add store.js auth.test.js
git commit -m "feat: store.js 持久化 auth 配置(密码 hash + 信任 IP 正则)"
```

---

### Task 2: auth.js — IP 信任判断 + 密码哈希

**Files:**
- Create: `auth.js`
- Modify: `auth.test.js`（追加）

**Interfaces:**
- Consumes: 无（不依赖 store.js，配置以参数传入）
- Produces: `auth.DEFAULT_PRIVATE_IP_REGEX_SOURCE`（字符串）；`auth.getClientIp(req, server)` → string；`auth.isTrustedIp(ip, authConfig)` → boolean（`authConfig` 形如 Task 1 的 `{ trustedIpsRegex }`）；`auth.hashPassword(password)` → `Promise<string>`；`auth.verifyPassword(password, hash)` → `Promise<boolean>`。

- [ ] **Step 1: 写失败的测试**

在 `auth.test.js` 顶部加 import，文件末尾追加测试：

```js
import * as auth from "./auth.js";
```

```js
test("isTrustedIp: 默认私网正则命中局域网/回环地址", () => {
  const cfg = { trustedIpsRegex: null };
  expect(auth.isTrustedIp("127.0.0.1", cfg)).toBe(true);
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(true);
  expect(auth.isTrustedIp("10.0.0.5", cfg)).toBe(true);
  expect(auth.isTrustedIp("172.20.0.9", cfg)).toBe(true);
});

test("isTrustedIp: 默认私网正则不命中公网地址", () => {
  const cfg = { trustedIpsRegex: null };
  expect(auth.isTrustedIp("8.8.8.8", cfg)).toBe(false);
  expect(auth.isTrustedIp("203.0.113.9", cfg)).toBe(false);
});

test("isTrustedIp: 自定义正则替换默认值(不叠加)", () => {
  const cfg = { trustedIpsRegex: "^203\\.0\\.113\\." };
  expect(auth.isTrustedIp("203.0.113.9", cfg)).toBe(true);
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(false);
});

test("getClientIp: 用 server.requestIP 返回地址, 没有 server 时返回 unknown", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "192.168.1.5" }) };
  expect(auth.getClientIp(req, server)).toBe("192.168.1.5");
  expect(auth.getClientIp(req, null)).toBe("unknown");
});

test("hashPassword / verifyPassword: 正确密码校验通过, 错误密码不通过", async () => {
  const hash = await auth.hashPassword("correct-horse");
  expect(await auth.verifyPassword("correct-horse", hash)).toBe(true);
  expect(await auth.verifyPassword("wrong", hash)).toBe(false);
});

test("verifyPassword: hash 为 null 时始终返回 false", async () => {
  expect(await auth.verifyPassword("anything", null)).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test auth.test.js`
Expected: FAIL —— 找不到模块 `./auth.js`

- [ ] **Step 3: 创建 auth.js**

```js
// auth.js —— 局域网/公网访问身份验证：IP 信任判断、密码哈希、session、限流。
// 不依赖 store.js（配置以参数传入），方便单测。

export const DEFAULT_PRIVATE_IP_REGEX_SOURCE =
  "^(127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|::1$|::ffff:127\\.|::ffff:10\\.|::ffff:192\\.168\\.)";

export function getClientIp(req, server) {
  const addr = server && typeof server.requestIP === "function" ? server.requestIP(req) : null;
  return (addr && addr.address) || "unknown";
}

export function isTrustedIp(ip, authConfig) {
  const source = (authConfig && authConfig.trustedIpsRegex) || DEFAULT_PRIVATE_IP_REGEX_SOURCE;
  let re;
  try { re = new RegExp(source); } catch { re = new RegExp(DEFAULT_PRIVATE_IP_REGEX_SOURCE); }
  return re.test(ip);
}

export async function hashPassword(password) {
  return Bun.password.hash(password);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  try { return await Bun.password.verify(password, hash); } catch { return false; }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test auth.test.js`
Expected: PASS（8 个测试全绿：Task 1 的 3 个 + 本任务 5 个）

- [ ] **Step 5: Commit**

```bash
git add auth.js auth.test.js
git commit -m "feat: auth.js IP 信任判断 + 密码哈希"
```

---

### Task 3: auth.js — Session 管理

**Files:**
- Modify: `auth.js`
- Modify: `auth.test.js`（追加）

**Interfaces:**
- Consumes: 无
- Produces: `auth.createSession()` → string token；`auth.hasValidSession(req)` → boolean；`auth.destroySession(req)` → void；`auth.sessionCookieHeader(token)` → string（`Set-Cookie` 值）；`auth.clearSessionCookieHeader()` → string。Session cookie 名固定为 `mock_session`。

- [ ] **Step 1: 写失败的测试**

在 `auth.test.js` 末尾追加：

```js
test("createSession / hasValidSession: 带正确 cookie 才算已登录", () => {
  const token = auth.createSession();
  const reqNoCookie = new Request("http://x/");
  expect(auth.hasValidSession(reqNoCookie)).toBe(false);
  const reqWithCookie = new Request("http://x/", { headers: { cookie: `mock_session=${token}` } });
  expect(auth.hasValidSession(reqWithCookie)).toBe(true);
});

test("destroySession: 登出后同一 token 的 session 失效", () => {
  const token = auth.createSession();
  const req = new Request("http://x/", { headers: { cookie: `mock_session=${token}` } });
  expect(auth.hasValidSession(req)).toBe(true);
  auth.destroySession(req);
  expect(auth.hasValidSession(req)).toBe(false);
});

test("sessionCookieHeader / clearSessionCookieHeader: 生成对应的 Set-Cookie 值", () => {
  expect(auth.sessionCookieHeader("abc123")).toContain("mock_session=abc123");
  expect(auth.sessionCookieHeader("abc123")).toContain("HttpOnly");
  expect(auth.clearSessionCookieHeader()).toContain("Max-Age=0");
});

test("hasValidSession: 多个 cookie 混在一起也能正确解析", () => {
  const token = auth.createSession();
  const req = new Request("http://x/", { headers: { cookie: `foo=bar; mock_session=${token}; baz=qux` } });
  expect(auth.hasValidSession(req)).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test auth.test.js`
Expected: FAIL —— `auth.createSession is not a function`

- [ ] **Step 3: 在 auth.js 末尾追加实现**

```js
const sessions = new Map(); // token -> createdAt(ms)
const SESSION_COOKIE_NAME = "mock_session";

export function createSession() {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now());
  return token;
}

function getSessionToken(req) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE_NAME + "="));
  return match ? match.slice(SESSION_COOKIE_NAME.length + 1) : null;
}

export function hasValidSession(req) {
  const token = getSessionToken(req);
  return !!token && sessions.has(token);
}

export function destroySession(req) {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
}

export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test auth.test.js`
Expected: PASS（12 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add auth.js auth.test.js
git commit -m "feat: auth.js session 登录态管理"
```

---

### Task 4: auth.js — 登录限流

**Files:**
- Modify: `auth.js`
- Modify: `auth.test.js`（追加）

**Interfaces:**
- Consumes: 无
- Produces: `auth.isLocked(ip)` → number（剩余锁定毫秒数，0 表示未锁定）；`auth.recordFailure(ip)` → void；`auth.recordSuccess(ip)` → void。规则：同一 `ip` 连续 5 次 `recordFailure` 后锁定 15 分钟；`recordSuccess` 清空该 `ip` 的失败计数和锁定状态。

- [ ] **Step 1: 写失败的测试**

在 `auth.test.js` 末尾追加（每个测试用不同的假 IP，避免互相污染内存态）：

```js
test("isLocked: 初始未锁定", () => {
  expect(auth.isLocked("203.0.113.1")).toBe(0);
});

test("recordFailure: 连续 5 次失败后锁定", () => {
  const ip = "203.0.113.2";
  for (let i = 0; i < 5; i++) auth.recordFailure(ip);
  expect(auth.isLocked(ip)).toBeGreaterThan(0);
});

test("recordFailure: 不满 5 次不锁定", () => {
  const ip = "203.0.113.3";
  for (let i = 0; i < 4; i++) auth.recordFailure(ip);
  expect(auth.isLocked(ip)).toBe(0);
});

test("recordSuccess: 清空失败计数, 之前的失败不会累加进下一轮", () => {
  const ip = "203.0.113.4";
  for (let i = 0; i < 4; i++) auth.recordFailure(ip);
  auth.recordSuccess(ip);
  auth.recordFailure(ip); // 清空后只失败了 1 次
  expect(auth.isLocked(ip)).toBe(0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test auth.test.js`
Expected: FAIL —— `auth.isLocked is not a function`

- [ ] **Step 3: 在 auth.js 末尾追加实现**

```js
const loginAttempts = new Map(); // ip -> { fails, lockedUntil }
const MAX_LOGIN_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export function isLocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || !rec.lockedUntil) return 0;
  const remain = rec.lockedUntil - Date.now();
  if (remain <= 0) { loginAttempts.delete(ip); return 0; }
  return remain;
}

export function recordFailure(ip) {
  const rec = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_LOGIN_FAILS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.fails = 0; }
  loginAttempts.set(ip, rec);
}

export function recordSuccess(ip) {
  loginAttempts.delete(ip);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test auth.test.js`
Expected: PASS（16 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add auth.js auth.test.js
git commit -m "feat: auth.js 登录限流(5 次失败锁 15 分钟)"
```

---

### Task 5: auth.js — checkAccess 汇总判断

**Files:**
- Modify: `auth.js`
- Modify: `auth.test.js`（追加）

**Interfaces:**
- Consumes: `isTrustedIp`、`getClientIp`、`hasValidSession`（均为本文件内函数）
- Produces: `auth.checkAccess(req, server, authConfig)` → `{ allowed: boolean, reason: "open"|"trusted-ip"|"session"|"unauthenticated" }`。这是 `server.js` 里认证网关唯一要调用的函数。

- [ ] **Step 1: 写失败的测试**

在 `auth.test.js` 末尾追加：

```js
test("checkAccess: 未设置密码 => 直接放行(reason=open)", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "8.8.8.8" }) };
  const result = auth.checkAccess(req, server, { passwordHash: null, trustedIpsRegex: null });
  expect(result).toEqual({ allowed: true, reason: "open" });
});

test("checkAccess: 设置密码 + 信任 IP => 放行(reason=trusted-ip)", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "192.168.1.5" }) };
  const result = auth.checkAccess(req, server, { passwordHash: "h", trustedIpsRegex: null });
  expect(result).toEqual({ allowed: true, reason: "trusted-ip" });
});

test("checkAccess: 设置密码 + 非信任 IP + 无 session => 拒绝", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "8.8.8.8" }) };
  const result = auth.checkAccess(req, server, { passwordHash: "h", trustedIpsRegex: null });
  expect(result).toEqual({ allowed: false, reason: "unauthenticated" });
});

test("checkAccess: 设置密码 + 非信任 IP + 有效 session => 放行(reason=session)", () => {
  const token = auth.createSession();
  const req = new Request("http://x/", { headers: { cookie: `mock_session=${token}` } });
  const server = { requestIP: () => ({ address: "8.8.8.8" }) };
  const result = auth.checkAccess(req, server, { passwordHash: "h", trustedIpsRegex: null });
  expect(result).toEqual({ allowed: true, reason: "session" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test auth.test.js`
Expected: FAIL —— `auth.checkAccess is not a function`

- [ ] **Step 3: 在 auth.js 末尾追加实现**

```js
export function checkAccess(req, server, authConfig) {
  if (!authConfig || !authConfig.passwordHash) return { allowed: true, reason: "open" };
  const ip = getClientIp(req, server);
  if (isTrustedIp(ip, authConfig)) return { allowed: true, reason: "trusted-ip" };
  if (hasValidSession(req)) return { allowed: true, reason: "session" };
  return { allowed: false, reason: "unauthenticated" };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test auth.test.js`
Expected: PASS（20 个测试全绿）

- [ ] **Step 5: Commit**

```bash
git add auth.js auth.test.js
git commit -m "feat: auth.js checkAccess 汇总判断"
```

---

### Task 6: server.js — 接入认证网关 + 路由 + 环境变量引导

**Files:**
- Modify: `server.js`（整体替换为下方目标内容）
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `store.load(dbPath?)`、`store.getAuthConfig()`、`store.setAuthConfig(patch)`（Task 1）；`auth.checkAccess`、`auth.getClientIp`、`auth.isTrustedIp`、`auth.hasValidSession`、`auth.isLocked`、`auth.recordFailure`、`auth.recordSuccess`、`auth.createSession`、`auth.destroySession`、`auth.sessionCookieHeader`、`auth.clearSessionCookieHeader`、`auth.hashPassword`、`auth.verifyPassword`（Task 2-5）
- Produces: 新路由 `GET /__auth/status`、`POST /__auth/login`、`POST /__auth/logout`、`POST /__auth/config`；`/__state` 响应新增 `lanIps: string[]`；控制台环境变量 `MOCK_ADMIN_PASSWORD`、`MOCK_TRUSTED_IPS`。

- [ ] **Step 1: 把 `server.js` 整个文件内容替换为**

```js
// server.js —— 带 Web 控制台的多模型/多格式假上游。入口。
//
// 跑法：  bun run server.js            (默认端口 8788, 可用 MOCK_PORT 改)
// 控制台：http://localhost:8788/
// 上游 Base URL：
//   OpenAI  渠道 -> http://localhost:8788           (打 /v1/chat/completions)
//   Claude  渠道 -> http://localhost:8788           (打 /v1/messages)
//   Gemini  渠道 -> http://localhost:8788           (打 /v1beta/models/{m}:generateContent)
//   Docker 下把 localhost 换成 host.docker.internal 或 compose 服务名。
//
// 局域网/公网访问 + 控制台身份验证：
//   面板"网络与安全"区块可设置管理密码 + 信任 IP 正则，落库 mock.db，改完立即生效。
//   也可用环境变量在启动时写入/覆盖： MOCK_ADMIN_PASSWORD / MOCK_TRUSTED_IPS
//   未设置密码时，控制台和 /v1/* 一样保持完全开放（不影响现有本地用法）。

import { networkInterfaces } from "os";
import * as store from "./store.js";
import * as auth from "./auth.js";
import { shouldInjectError } from "./usage.js";
import * as openai from "./formats/openai.js";
import * as claude from "./formats/claude.js";
import * as gemini from "./formats/gemini.js";

const PORT = Number(process.env.MOCK_PORT || 8788);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const recent = [];
function record(e) { recent.unshift({ t: new Date().toISOString().slice(11, 19), ...e }); if (recent.length > 25) recent.pop(); }

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "X-Mock-Upstream": "1" } });

await store.load();

// 环境变量引导：设置了就每次启动覆盖 DB 中的密码/信任正则；不设置则以 DB(面板改的)为准。
if (process.env.MOCK_ADMIN_PASSWORD) {
  store.setAuthConfig({ passwordHash: await auth.hashPassword(process.env.MOCK_ADMIN_PASSWORD) });
}
if (process.env.MOCK_TRUSTED_IPS) {
  store.setAuthConfig({ trustedIpsRegex: process.env.MOCK_TRUSTED_IPS });
}

function lanIps() {
  const nets = networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function loginPageHtml() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>登录 · Mock 上游控制台</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#0f1115; color:#e6e8ec; font:14px/1.5 -apple-system,Segoe UI,Roboto,"Microsoft YaHei",sans-serif; }
  form { background:#181b22; border:1px solid #2a2f3a; border-radius:10px; padding:28px; width:280px; }
  h1 { font-size:15px; margin:0 0 16px; }
  input { width:100%; background:#0e1016; color:#e6e8ec; border:1px solid #2a2f3a; border-radius:7px;
          padding:9px 10px; font-size:13px; box-sizing:border-box; margin-bottom:10px; }
  button { width:100%; background:#5b9dff; border:none; color:#04122b; font-weight:600; padding:9px; border-radius:7px; cursor:pointer; }
  .err { color:#f85149; font-size:12px; min-height:16px; margin-bottom:8px; }
</style></head>
<body>
<form id="f">
  <h1>Mock 上游控制台 · 登录</h1>
  <div class="err" id="err"></div>
  <input type="password" id="pw" placeholder="管理密码" autofocus />
  <button type="submit">登录</button>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const r = await fetch("/__auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  if (r.ok) { location.href = "/"; return; }
  if (r.status === 429) { const d = await r.json(); err.textContent = "失败次数过多，请 " + Math.ceil(d.retryAfterMs / 60000) + " 分钟后再试"; return; }
  err.textContent = "密码错误";
});
</script>
</body></html>`;
}

// 通用: 处理一次上游请求(某格式)
async function handleUpstream(fmtName, fmt, req, url) {
  const body = await req.json().catch(() => ({}));
  const parsed = fmt.parseRequest(body, url);
  const cfg = store.resolveModel(parsed.model, fmtName);

  if (Number(cfg.latencyMs) > 0) await sleep(Number(cfg.latencyMs));

  // 注入错误
  if (shouldInjectError(cfg)) {
    record({ model: parsed.model || cfg.id, format: fmtName, stream: parsed.stream, result: `ERR ${cfg.errorStatus}` });
    return json(fmt.buildError(cfg), Number(cfg.errorStatus));
  }

  const modelName = parsed.model || cfg.id;

  // 非流式
  if (!parsed.stream) {
    const resp = fmt.buildResponse(cfg, parsed.messages, modelName);
    record({ model: modelName, format: fmtName, stream: false, result: usageTag(fmtName, resp) });
    return json(resp);
  }

  // 流式 (SSE)
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const push = (line) => controller.enqueue(enc.encode(line));
      if (fmtName === "claude") {
        // Claude: 具名事件  event: X\n data: {...}\n\n
        await fmt.buildStream(cfg, parsed.messages, modelName, (event, data) => {
          push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }, sleep);
      } else {
        // openai / gemini: data: {...}\n\n ; openai 末尾 send("[DONE]")
        await fmt.buildStream(cfg, parsed.messages, modelName, (obj) => {
          if (obj === "[DONE]") push("data: [DONE]\n\n");
          else push(`data: ${JSON.stringify(obj)}\n\n`);
        }, sleep);
      }
      controller.close();
    },
  });
  record({ model: modelName, format: fmtName, stream: true, result: "stream" });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Mock-Upstream": "1" },
  });
}

function usageTag(fmtName, resp) {
  if (fmtName === "openai") { const u = resp.usage; return `p${u.prompt_tokens}/c${u.completion_tokens}/cache${u.prompt_tokens_details.cached_tokens}`; }
  if (fmtName === "claude") { const u = resp.usage; return `in${u.input_tokens}/out${u.output_tokens}/read${u.cache_read_input_tokens}`; }
  const u = resp.usageMetadata; return `p${u.promptTokenCount}/c${u.candidatesTokenCount}/cache${u.cachedContentTokenCount || 0}`;
}

Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    const p = url.pathname;

    // ---------- 身份验证网关：控制台页面 + 全部 /__* 管理接口 ----------
    const authExempt = p === "/__auth/login" || p === "/__auth/status" || p === "/vendor/alpine.min.js";
    const authGated = !authExempt && (p === "/" || p === "/index.html" || p.startsWith("/__"));
    if (authGated) {
      const access = auth.checkAccess(req, server, store.getAuthConfig());
      if (!access.allowed) {
        if (p === "/" || p === "/index.html")
          return new Response(loginPageHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        return json({ error: "unauthorized" }, 401);
      }
    }

    // ---------- 认证相关路由 ----------
    if (p === "/__auth/status" && req.method === "GET") {
      const cfg = store.getAuthConfig();
      return json({
        passwordSet: !!cfg.passwordHash,
        trustedByIp: cfg.passwordHash ? auth.isTrustedIp(auth.getClientIp(req, server), cfg) : true,
        authenticated: auth.hasValidSession(req),
        trustedIpsRegex: cfg.trustedIpsRegex,
      });
    }
    if (p === "/__auth/login" && req.method === "POST") {
      const ip = auth.getClientIp(req, server);
      const remain = auth.isLocked(ip);
      if (remain > 0) return json({ error: "locked", retryAfterMs: remain }, 429);
      const { password } = await req.json().catch(() => ({}));
      const cfg = store.getAuthConfig();
      const ok = await auth.verifyPassword(password || "", cfg.passwordHash);
      if (!ok) { auth.recordFailure(ip); return json({ error: "bad password" }, 401); }
      auth.recordSuccess(ip);
      const token = auth.createSession();
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": auth.sessionCookieHeader(token) },
      });
    }
    if (p === "/__auth/logout" && req.method === "POST") {
      auth.destroySession(req);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": auth.clearSessionCookieHeader() },
      });
    }
    if (p === "/__auth/config" && req.method === "POST") {
      const { password, trustedIpsRegex } = await req.json().catch(() => ({}));
      const patch = {};
      if (typeof trustedIpsRegex === "string") patch.trustedIpsRegex = trustedIpsRegex.trim() || null;
      if (password) patch.passwordHash = await auth.hashPassword(password);
      const next = store.setAuthConfig(patch);
      return json({ ok: true, passwordSet: !!next.passwordHash, trustedIpsRegex: next.trustedIpsRegex });
    }

    // ---------- 控制台前端 ----------
    if (p === "/" || p === "/index.html")
      return new Response(Bun.file(import.meta.dir + "/panel.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p === "/vendor/alpine.min.js")
      return new Response(Bun.file(import.meta.dir + "/vendor/alpine.min.js"), { headers: { "Content-Type": "text/javascript" } });

    // ---------- 管理 API ----------
    if (p === "/__state") return json({ ...store.getState(), port: PORT, lanIps: lanIps() });
    if (p === "/__stats") return json({ recent });
    if (p === "/__models" && req.method === "POST") {
      const m = await req.json().catch(() => ({}));
      return json({ ok: true, model: await store.upsertModel(m) });
    }
    if (p.startsWith("/__models/") && req.method === "DELETE") {
      await store.deleteModel(decodeURIComponent(p.slice("/__models/".length)));
      return json({ ok: true });
    }
    if (p.match(/^\/__models\/.+\/apply-preset$/) && req.method === "POST") {
      const id = decodeURIComponent(p.split("/")[2]);
      const { name } = await req.json().catch(() => ({}));
      const model = await store.applyPreset(id, name);
      return model ? json({ ok: true, model }) : json({ error: "model or preset not found" }, 404);
    }
    if (p === "/__presets" && req.method === "POST") {
      const { name, patch } = await req.json().catch(() => ({}));
      const pr = await store.upsertPreset(name, patch);
      return pr ? json({ ok: true, preset: pr }) : json({ error: "preset name required" }, 400);
    }
    if (p.startsWith("/__presets/") && req.method === "DELETE") {
      await store.deletePreset(decodeURIComponent(p.slice("/__presets/".length)));
      return json({ ok: true });
    }
    if (p === "/__reset" && req.method === "POST") return json({ ok: true, state: await store.reset() });

    // ---------- 上游 API ----------
    if (p === "/v1/models") {
      const data = store.getState().models
        .filter((m) => m.format === "openai")
        .map((m) => ({ id: m.id, object: "model", owned_by: "mock" }));
      if (!data.length) data.push({ id: "gpt-3.5-turbo", object: "model", owned_by: "mock" });
      return json({ object: "list", data });
    }
    if (p === "/v1/chat/completions" && req.method === "POST") return handleUpstream("openai", openai, req, url);
    if (p === "/v1/messages" && req.method === "POST") return handleUpstream("claude", claude, req, url);
    if (p.match(/\/models\/[^:]+:(generateContent|streamGenerateContent)/) && req.method === "POST")
      return handleUpstream("gemini", gemini, req, url);

    return new Response("mock upstream: not found " + p, { status: 404 });
  },
  error(e) {
    if (e.code === "EADDRINUSE")
      console.error(`\n端口 ${PORT} 被占用。改端口: MOCK_PORT=9999 bun run server.js  或先杀掉占用进程。\n`);
    throw e;
  },
});

console.log(`mock upstream listening on http://localhost:${PORT}`);
console.log(`→ 控制台:      http://localhost:${PORT}/`);
console.log(`→ 渠道 Base URL: http://localhost:${PORT}   (Docker: http://host.docker.internal:${PORT})`);
console.log(`  OpenAI /v1/chat/completions · Claude /v1/messages · Gemini /v1beta/models/{m}:generateContent`);
if (!store.getAuthConfig().passwordHash) {
  console.log(`  提醒: 控制台尚未设置密码，谁都能访问和修改配置。要给局域网/公网同事用之前，去面板"网络与安全"设一个。`);
}
```

- [ ] **Step 2: 修改 `docker-compose.yml`**

把 `environment:` 段改成：

```yaml
    environment:
      - MOCK_PORT=8788
      # 局域网/公网访问身份验证（可选；也可以直接在面板"网络与安全"里设置，不需要改这里重启容器）：
      # - MOCK_ADMIN_PASSWORD=change-me
      # - MOCK_TRUSTED_IPS=^192\.168\.
```

- [ ] **Step 3: 跑现有单测确认没有回归**

Run: `bun test`
Expected: `formats.test.js` 和 `auth.test.js` 全部 PASS（`server.js` 本身没有自动化测试覆盖，这一步只是确认没有语法错误/导入错误导致其他测试跟着挂掉）。

- [ ] **Step 4: 手动烟雾测试（认证网关端到端验证）**

在项目根目录起一个临时端口，跑一遍完整流程（Windows Git Bash）：

```bash
MOCK_PORT=8799 bun run server.js &
sleep 1

# 1) 未设密码：完全开放
curl -s http://localhost:8799/__auth/status
# 期望: {"passwordSet":false,"trustedByIp":true,"authenticated":false,"trustedIpsRegex":null}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8799/__state
# 期望: 200

# 2) 设置密码后, 127.0.0.1 命中默认私网信任正则, 仍然免登录
curl -s -X POST http://localhost:8799/__auth/config -H "Content-Type: application/json" -d '{"password":"test1234"}'
# 期望: {"ok":true,"passwordSet":true,"trustedIpsRegex":null}
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8799/__state
# 期望: 200

# 3) 自定义信任正则替换默认值后, 127.0.0.1 不再命中, 要求登录
curl -s -X POST http://localhost:8799/__auth/config -H "Content-Type: application/json" -d '{"trustedIpsRegex":"^203\\.0\\.113\\."}'
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8799/__state
# 期望: 401

# 4) 密码错误
curl -s -X POST http://localhost:8799/__auth/login -H "Content-Type: application/json" -d '{"password":"wrong"}'
# 期望: {"error":"bad password"}  (401)

# 5) 密码正确, session cookie 生效
curl -s -c /tmp/mockcookie.txt -X POST http://localhost:8799/__auth/login -H "Content-Type: application/json" -d '{"password":"test1234"}'
# 期望: {"ok":true}
curl -s -b /tmp/mockcookie.txt -o /dev/null -w "%{http_code}\n" http://localhost:8799/__state
# 期望: 200

# 6) 登出后 cookie 失效
curl -s -b /tmp/mockcookie.txt -X POST http://localhost:8799/__auth/logout
curl -s -b /tmp/mockcookie.txt -o /dev/null -w "%{http_code}\n" http://localhost:8799/__state
# 期望: 401

kill %1
rm -f /tmp/mockcookie.txt mock.db   # mock.db 是这次手动测试产生的, 删掉避免污染本地开发库(下次启动会自动重建默认数据)
```

全部符合预期才算通过；有任何一步不符，回去检查对应路由。

- [ ] **Step 5: Commit**

```bash
git add server.js docker-compose.yml
git commit -m "feat: server.js 接入认证网关 + /__auth/* 路由 + 局域网地址探测"
```

---

### Task 7: panel.html — Tab 布局改版 + 网络与安全区块

**Files:**
- Modify: `panel.html`（整体替换为下方目标内容）

**Interfaces:**
- Consumes: `GET /__auth/status` → `{ passwordSet, authenticated, trustedByIp, trustedIpsRegex }`；`POST /__auth/config`；`POST /__auth/login`；`POST /__auth/logout`；`GET /__state` → 新增 `port`、`lanIps`（Task 6）
- Produces: 无（叶子任务，前端最终形态）

- [ ] **Step 1: 把 `panel.html` 整个文件内容替换为**

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mock 上游控制台</title>
<script defer src="/vendor/alpine.min.js"></script>
<style>
  :root { --bg:#0f1115; --panel:#181b22; --line:#2a2f3a; --fg:#e6e8ec; --mut:#9aa3b2;
          --acc:#5b9dff; --ok:#3fb950; --warn:#e3b341; --err:#f85149;
          --openai:#10a37f; --claude:#d97757; --gemini:#4285f4; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 -apple-system,Segoe UI,Roboto,"Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  header { padding:13px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; font-weight:600; }
  header .dot { width:9px; height:9px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px var(--ok); }
  header .base { margin-left:auto; color:var(--mut); font-size:12px; font-family:ui-monospace,Consolas,monospace; }
  header .authbadge { font-size:11px; padding:2px 9px; border-radius:20px; font-weight:600; }
  header .authbadge.on { background:rgba(63,185,80,.15); color:var(--ok); }
  header .authbadge.off { background:rgba(227,179,65,.15); color:var(--warn); }
  header .logout { padding:4px 10px; font-size:12px; }
  .layout { display:grid; grid-template-columns:260px 1fr; gap:0; height:calc(100vh - 51px); }
  .side { border-right:1px solid var(--line); padding:14px; overflow:auto; }
  .main { padding:16px 20px; overflow:auto; }
  .side h2, .main h2 { font-size:12px; margin:0 0 10px; color:var(--mut); text-transform:uppercase; letter-spacing:.04em; }
  .mrow { display:flex; align-items:center; gap:8px; padding:9px 10px; border:1px solid var(--line); border-radius:8px;
          margin-bottom:7px; cursor:pointer; background:var(--panel); }
  .mrow.active { border-color:var(--acc); box-shadow:0 0 0 1px var(--acc) inset; }
  .mrow .name { font-weight:600; font-size:13px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .badge { font-size:10px; padding:1px 7px; border-radius:20px; font-weight:600; text-transform:uppercase; }
  .badge.openai { background:rgba(16,163,127,.15); color:var(--openai); }
  .badge.claude { background:rgba(217,119,87,.15); color:var(--claude); }
  .badge.gemini { background:rgba(66,133,244,.15); color:var(--gemini); }
  .sidebtns { display:flex; gap:6px; margin-bottom:12px; }
  button { cursor:pointer; border:1px solid var(--line); background:#20242e; color:var(--fg); padding:7px 13px; border-radius:7px; font-size:13px; }
  button.primary { background:var(--acc); border-color:var(--acc); color:#04122b; font-weight:600; }
  button.sm { padding:4px 9px; font-size:12px; }
  button.danger { color:var(--err); }
  button:hover { filter:brightness(1.12); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
  .presets { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:6px; }
  .presets button { background:#20242e; border-color:var(--line); }
  .row { display:grid; grid-template-columns:140px 1fr; gap:10px; align-items:center; margin-bottom:10px; }
  .row label { color:var(--mut); font-size:13px; }
  input, select, textarea { width:100%; background:#0e1016; color:var(--fg); border:1px solid var(--line); border-radius:7px;
          padding:7px 9px; font:13px ui-monospace,Consolas,monospace; }
  textarea { resize:vertical; min-height:50px; font-family:inherit; }
  input:focus, select:focus, textarea:focus { outline:none; border-color:var(--acc); }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .btns { display:flex; gap:10px; margin-top:4px; }
  .hint { color:var(--mut); font-size:12px; margin-top:8px; }
  .ep { font-family:ui-monospace,Consolas,monospace; font-size:12px; background:#0e1016; border:1px solid var(--line);
        border-radius:6px; padding:6px 9px; color:var(--acc); display:flex; align-items:center; gap:8px; margin-bottom:6px; }
  .ep code { flex:1; overflow:auto; white-space:nowrap; }
  table { width:100%; border-collapse:collapse; font-size:12px; font-family:ui-monospace,Consolas,monospace; }
  td, th { text-align:left; padding:5px 6px; border-bottom:1px solid var(--line); }
  th { color:var(--mut); font-weight:500; }
  .pill { display:inline-block; padding:1px 7px; border-radius:20px; font-size:11px; }
  .pill.err { background:rgba(248,81,73,.15); color:var(--err); } .pill.ok { background:rgba(63,185,80,.15); color:var(--ok); }
  .toast { position:fixed; right:16px; bottom:16px; background:var(--ok); color:#04120a; padding:9px 14px; border-radius:8px;
           opacity:0; transition:opacity .2s; font-weight:600; z-index:9; }
  .toast.show { opacity:1; }
  pre { background:#0e1016; border:1px solid var(--line); border-radius:7px; padding:10px; overflow:auto; max-height:220px; font-size:12px; margin:0; }
  .tabs { display:flex; gap:6px; margin-bottom:16px; border-bottom:1px solid var(--line); padding-bottom:10px; }
  .tabs button { background:transparent; border:1px solid transparent; color:var(--mut); }
  .tabs button.active { background:var(--panel); border-color:var(--line); color:var(--fg); }
  .warnbar { background:rgba(227,179,65,.12); border:1px solid rgba(227,179,65,.4); color:var(--warn);
             border-radius:8px; padding:9px 12px; font-size:12.5px; margin-bottom:16px; }
</style>
</head>
<body x-data="app()" x-init="init()">
<header>
  <span class="dot"></span>
  <h1>Mock 上游控制台</h1>
  <span class="base" x-text="'Base URL → ' + origin"></span>
  <template x-if="auth.passwordSet">
    <span class="authbadge" :class="auth.trustedByIp || auth.authenticated ? 'on' : 'off'"
          x-text="auth.trustedByIp ? '信任 IP 免登录' : (auth.authenticated ? '已登录' : '未登录')"></span>
  </template>
  <template x-if="!auth.passwordSet">
    <span class="authbadge off">未设置密码</span>
  </template>
  <button class="sm logout" x-show="auth.authenticated" @click="logout()">退出登录</button>
</header>

<div class="layout">
  <!-- 左：模型列表 -->
  <div class="side">
    <div class="sidebtns">
      <button class="sm primary" @click="addModel()">+ 新建</button>
      <button class="sm" @click="dupModel()" :disabled="!sel">复制</button>
      <button class="sm danger" @click="delModel()" :disabled="!sel">删除</button>
    </div>
    <h2>模型（<span x-text="models.length"></span>）</h2>
    <template x-for="m in models" :key="m.id">
      <div class="mrow" :class="{active: sel && sel.id===m.id}" @click="select(m.id)">
        <span class="name" x-text="m.id"></span>
        <span class="badge" :class="m.format" x-text="m.format"></span>
      </div>
    </template>
  </div>

  <!-- 右：Tab + 内容 -->
  <div class="main">
    <div class="warnbar" x-show="!auth.passwordSet">
      尚未设置管理密码，任何能访问这个页面的人都可以修改所有配置。要给局域网/公网同事用之前，先去「网络与安全」设一个。
    </div>

    <div class="tabs">
      <button :class="{active: tab==='models'}" @click="tab='models'">模型配置</button>
      <button :class="{active: tab==='presets'}" @click="tab='presets'">预设管理</button>
      <button :class="{active: tab==='recent'}" @click="tab='recent'">最近请求</button>
      <button :class="{active: tab==='network'}" @click="tab='network'">网络与安全</button>
    </div>

    <!-- ===== 模型配置 ===== -->
    <template x-if="tab==='models'">
      <div>
        <div class="card">
          <h2>预设（一键套用到当前模型）</h2>
          <div class="presets">
            <template x-for="p in presets" :key="p.name">
              <button @click="applyPreset(p.name)" x-text="p.name"></button>
            </template>
          </div>
          <div class="hint">点预设会填入下面的表单，仍需点「保存」写入生效。</div>
        </div>

        <div class="card" x-show="sel">
          <h2>模型配置</h2>
          <div class="row"><label>模型名 id</label><input x-model="sel.id" /></div>
          <div class="row"><label>协议格式</label>
            <select x-model="sel.format">
              <option value="openai">openai（/v1/chat/completions）</option>
              <option value="claude">claude（/v1/messages）</option>
              <option value="gemini">gemini（:generateContent）</option>
            </select>
          </div>
          <div class="row"><label>回复内容</label><textarea x-model="sel.content"></textarea></div>
          <div class="hint" style="margin:-4px 0 10px">回复内容=实际返回的文本（原样，不截断）；「输出 token」只是**上报的计费数字**，与正文长度无关，互不影响。</div>
          <div class="row"><label>输入 token</label>
            <div class="grid2">
              <select x-model="sel.promptMode"><option value="auto">auto（按输入估算）</option><option value="fixed">fixed（固定）</option></select>
              <input type="number" x-model.number="sel.promptTokens" />
            </div>
          </div>
          <div class="row"><label>输出 token</label><input type="number" x-model.number="sel.completionTokens" /></div>
          <div class="row"><label>缓存命中</label>
            <div class="grid2">
              <select x-model="sel.cacheMode"><option value="none">none</option><option value="ratio">ratio（比例）</option><option value="fixed">fixed（固定）</option></select>
              <input type="number" step="0.05" x-model.number="sel.cacheRatio" x-show="sel.cacheMode==='ratio'" />
              <input type="number" x-model.number="sel.cachedTokens" x-show="sel.cacheMode==='fixed'" />
            </div>
          </div>
          <div class="row"><label>缓存写入(Claude)</label><input type="number" x-model.number="sel.cacheCreationTokens" /></div>
          <div class="row"><label>响应延迟 ms</label><input type="number" x-model.number="sel.latencyMs" /></div>
          <div class="row"><label>流式块间隔 ms</label><input type="number" x-model.number="sel.chunkDelayMs" /></div>
          <div class="row"><label>注入错误码</label>
            <div class="grid2">
              <select x-model.number="sel.errorStatus"><option :value="0">不注入</option><option :value="400">400</option><option :value="401">401</option><option :value="403">403</option><option :value="429">429</option><option :value="500">500</option><option :value="503">503</option></select>
              <input type="number" min="0" max="100" x-model.number="sel.errorRate" title="触发概率 %" />
            </div>
          </div>
          <div class="row"><label>错误信息</label><input x-model="sel.errorMessage" /></div>
          <div class="btns"><button class="primary" @click="saveModel()">保存</button></div>
          <div class="hint" style="margin-top:12px">该渠道 Base URL（复制到 new-api 渠道）：</div>
          <div class="ep"><code x-text="origin"></code><button class="sm" @click="copy(origin)">复制</button></div>
          <div class="ep"><code x-text="endpointHint()"></code></div>
          <div class="hint">Docker 下把 <code>localhost</code> 换成 <code>host.docker.internal</code>。</div>
        </div>
      </div>
    </template>

    <!-- ===== 预设管理 ===== -->
    <template x-if="tab==='presets'">
      <div class="card">
        <h2>预设管理（自定义 / 编辑 / 删除）</h2>
        <div class="presets" style="margin-bottom:10px; align-items:center">
          <template x-for="p in presets" :key="p.name">
            <span style="display:inline-flex; gap:4px; align-items:center; border:1px solid var(--line); border-radius:7px; padding:2px 2px 2px 4px">
              <button class="sm" style="border:none; background:transparent" @click="editPreset(p)" x-text="p.name"></button>
              <button class="sm danger" style="border:none; background:transparent; padding:2px 6px" @click="delPreset(p.name)">×</button>
            </span>
          </template>
          <button class="sm primary" @click="newPreset()">+ 新建预设</button>
        </div>

        <template x-if="editingPreset">
          <div style="border-top:1px solid var(--line); padding-top:12px">
            <div class="row"><label>预设名</label><input x-model="presetForm.name" placeholder="预设名称" /></div>
            <div class="row"><label>输入 token</label>
              <div class="grid2">
                <select x-model="presetForm.promptMode"><option value="auto">auto</option><option value="fixed">fixed</option></select>
                <input type="number" x-model.number="presetForm.promptTokens" />
              </div>
            </div>
            <div class="row"><label>输出 token</label><input type="number" x-model.number="presetForm.completionTokens" /></div>
            <div class="row"><label>缓存命中</label>
              <div class="grid2">
                <select x-model="presetForm.cacheMode"><option value="none">none</option><option value="ratio">ratio</option><option value="fixed">fixed</option></select>
                <input type="number" step="0.05" x-model.number="presetForm.cacheRatio" x-show="presetForm.cacheMode==='ratio'" />
                <input type="number" x-model.number="presetForm.cachedTokens" x-show="presetForm.cacheMode==='fixed'" />
              </div>
            </div>
            <div class="row"><label>缓存写入(Claude)</label><input type="number" x-model.number="presetForm.cacheCreationTokens" /></div>
            <div class="row"><label>响应延迟 ms</label><input type="number" x-model.number="presetForm.latencyMs" /></div>
            <div class="row"><label>流式块间隔 ms</label><input type="number" x-model.number="presetForm.chunkDelayMs" /></div>
            <div class="row"><label>注入错误码</label>
              <div class="grid2">
                <select x-model.number="presetForm.errorStatus"><option :value="0">不注入</option><option :value="400">400</option><option :value="401">401</option><option :value="403">403</option><option :value="429">429</option><option :value="500">500</option><option :value="503">503</option></select>
                <input type="number" min="0" max="100" x-model.number="presetForm.errorRate" />
              </div>
            </div>
            <div class="row"><label>错误信息</label><input x-model="presetForm.errorMessage" /></div>
            <div class="btns"><button class="primary" @click="savePresetForm()">保存预设</button><button @click="editingPreset=''">取消</button></div>
            <div class="hint">预设是完整行为快照（不含模型名/格式/回复内容），套用即得确定结果——只改你要的字段即可。</div>
          </div>
        </template>
      </div>
    </template>

    <!-- ===== 最近请求 ===== -->
    <template x-if="tab==='recent'">
      <div class="card">
        <h2>最近请求</h2>
        <table><thead><tr><th>时间</th><th>模型</th><th>格式</th><th>流</th><th>结果</th></tr></thead>
          <tbody>
            <template x-for="(x,i) in recent" :key="i">
              <tr><td x-text="x.t"></td><td x-text="x.model"></td><td><span class="badge" :class="x.format" x-text="x.format"></span></td>
                  <td x-text="x.stream?'✓':'—'"></td>
                  <td><span class="pill" :class="String(x.result).startsWith('ERR')?'err':'ok'" x-text="x.result"></span></td></tr>
            </template>
            <tr x-show="!recent.length"><td colspan="5" style="color:var(--mut)">暂无</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- ===== 网络与安全 ===== -->
    <template x-if="tab==='network'">
      <div>
        <div class="card">
          <h2>当前访问地址</h2>
          <div class="ep"><code x-text="'http://localhost:' + port"></code><button class="sm" @click="copy('http://localhost:' + port)">复制</button></div>
          <template x-for="ip in lanIps" :key="ip">
            <div class="ep"><code x-text="'http://' + ip + ':' + port"></code><button class="sm" @click="copy('http://' + ip + ':' + port)">复制</button></div>
          </template>
          <div class="hint" x-show="!lanIps.length">没探测到局域网网卡地址（可能只有回环网卡）。</div>
          <div class="hint">同事在同一局域网/VPN 内，用上面带局域网 IP 的地址直接访问即可。</div>
        </div>

        <div class="card">
          <h2>暴露公网</h2>
          <div class="hint">
            把端口转发/反向代理到本机 <span x-text="port"></span> 端口即可从公网访问。建议：<br />
            1. 一定先在下面设置管理密码，再暴露端口。<br />
            2. 有条件的话在前面套一层反向代理（Nginx / Caddy）做 HTTPS，登录请求走明文公网不安全。<br />
            3. 反向代理场景下如果同事反馈"局域网网段没被识别为信任 IP"，通常是反代把源 IP 换成了自己的地址——这种情况请把反代自身出口 IP 或反代所在网段也写进下面的信任正则。
          </div>
        </div>

        <div class="card">
          <h2>管理密码</h2>
          <div class="hint" x-show="!auth.passwordSet">当前未设置，控制台完全开放。</div>
          <div class="hint" x-show="auth.passwordSet">已设置。留空「新密码」保存则不修改密码。</div>
          <div class="row"><label>新密码</label><input type="password" x-model="authForm.password" placeholder="留空=不修改" /></div>
          <div class="btns"><button class="primary" @click="savePassword()">保存密码</button></div>
        </div>

        <div class="card">
          <h2>信任 IP 正则</h2>
          <div class="hint">
            命中正则的来源 IP 直接免登录访问控制台。留空 = 使用默认值（信任局域网/回环网段：127.*、10.*、172.16-31.*、192.168.*）。
            自定义正则会<b>完全替换</b>默认值，不是叠加——公网场景下如果还想让局域网同事免登录，要把局域网网段也写进正则里。
          </div>
          <div class="row"><label>正则</label><input x-model="authForm.trustedIpsRegex" placeholder="例如 ^(192\.168\.|203\.0\.113\.)" /></div>
          <div class="btns"><button class="primary" @click="saveTrustedIps()">保存正则</button></div>
        </div>
      </div>
    </template>
  </div>
</div>

<div class="toast" :class="{show:toastMsg}" x-text="toastMsg" x-data="{}"></div>

<script>
function app() {
  return {
    origin: location.origin,
    tab: "models",
    models: [], presets: [], recent: [], sel: null, toastMsg: "",
    editingPreset: "", presetForm: {},
    port: "", lanIps: [],
    auth: { passwordSet: false, authenticated: false, trustedByIp: true, trustedIpsRegex: "" },
    authForm: { password: "", trustedIpsRegex: "" },
    async init() {
      await this.loadState();
      await this.loadAuthStatus();
      if (this.models.length) this.select(this.models[0].id);
      this.pollStats();
      setInterval(() => this.pollStats(), 4000);
    },
    async loadState() {
      const r = await fetch("/__state"); const s = await r.json();
      this.models = s.models; this.presets = s.presets; this.port = s.port; this.lanIps = s.lanIps || [];
      if (this.sel) { const still = this.models.find(m => m.id === this.sel.id); this.sel = still ? JSON.parse(JSON.stringify(still)) : (this.models[0] ? JSON.parse(JSON.stringify(this.models[0])) : null); }
    },
    async loadAuthStatus() {
      const r = await fetch("/__auth/status"); const s = await r.json();
      this.auth = s; this.authForm.trustedIpsRegex = s.trustedIpsRegex || "";
    },
    select(id) { const m = this.models.find(x => x.id === id); this.sel = m ? JSON.parse(JSON.stringify(m)) : null; },
    toast(msg, ok=true) { this.toastMsg = msg; setTimeout(() => this.toastMsg = "", 1600); },
    async saveModel() {
      const r = await fetch("/__models", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(this.sel) });
      if (r.ok) { const {model} = await r.json(); await this.loadState(); this.select(model.id); this.toast("已保存并生效"); }
      else this.toast("保存失败", false);
    },
    async addModel() {
      const base = { id: "new-model-" + (this.models.length+1), format:"openai", content:"mock 回复",
        promptMode:"auto", promptTokens:100, completionTokens:30, cacheMode:"none", cacheRatio:0.5,
        cachedTokens:0, cacheCreationTokens:0, latencyMs:0, chunkDelayMs:40, errorStatus:0, errorRate:0, errorMessage:"mock injected error" };
      await fetch("/__models", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(base) });
      await this.loadState(); this.select(base.id); this.toast("已新建模型");
    },
    async dupModel() {
      if (!this.sel) return;
      const copy = JSON.parse(JSON.stringify(this.sel)); copy.id = this.sel.id + "-copy";
      await fetch("/__models", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(copy) });
      await this.loadState(); this.select(copy.id); this.toast("已复制");
    },
    async delModel() {
      if (!this.sel || !confirm("删除模型 " + this.sel.id + "？")) return;
      await fetch("/__models/" + encodeURIComponent(this.sel.id), { method:"DELETE" });
      this.sel = null; await this.loadState(); if (this.models.length) this.select(this.models[0].id); this.toast("已删除");
    },
    async applyPreset(name) {
      if (!this.sel) return;
      await fetch("/__models", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify(this.sel) });
      const r = await fetch("/__models/" + encodeURIComponent(this.sel.id) + "/apply-preset", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ name }) });
      if (r.ok) { const {model} = await r.json(); await this.loadState(); this.select(model.id); this.toast("已套用预设「" + name + "」"); }
      else this.toast("套用失败", false);
    },
    async pollStats() { const r = await fetch("/__stats"); this.recent = (await r.json()).recent; },
    presetDefaults() {
      return { promptMode:"auto", promptTokens:100, completionTokens:30, cacheMode:"none", cacheRatio:0.5,
        cachedTokens:0, cacheCreationTokens:0, latencyMs:0, chunkDelayMs:40, errorStatus:0, errorRate:0, errorMessage:"mock injected error" };
    },
    newPreset() { this.editingPreset = "__new__"; this.presetForm = { name:"", ...this.presetDefaults() }; },
    editPreset(p) { this.editingPreset = p.name; this.presetForm = { name:p.name, ...this.presetDefaults(), ...p.patch }; },
    async savePresetForm() {
      const { name, ...patch } = this.presetForm;
      if (!String(name || "").trim()) { this.toast("请填预设名", false); return; }
      await fetch("/__presets", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ name, patch }) });
      this.editingPreset = ""; await this.loadState(); this.toast("预设已保存");
    },
    async delPreset(name) {
      if (!confirm("删除预设 " + name + "？")) return;
      await fetch("/__presets/" + encodeURIComponent(name), { method:"DELETE" });
      if (this.editingPreset === name) this.editingPreset = "";
      await this.loadState(); this.toast("预设已删除");
    },
    endpointHint() {
      if (!this.sel) return "";
      if (this.sel.format === "openai") return "POST " + this.origin + "/v1/chat/completions";
      if (this.sel.format === "claude") return "POST " + this.origin + "/v1/messages";
      return "POST " + this.origin + "/v1beta/models/" + this.sel.id + ":generateContent";
    },
    copy(t) { navigator.clipboard?.writeText(t); this.toast("已复制"); },
    async savePassword() {
      if (!this.authForm.password) { this.toast("请输入新密码", false); return; }
      const r = await fetch("/__auth/config", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ password: this.authForm.password }) });
      if (r.ok) { this.authForm.password = ""; await this.loadAuthStatus(); this.toast("密码已保存"); }
      else this.toast("保存失败", false);
    },
    async saveTrustedIps() {
      const r = await fetch("/__auth/config", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ trustedIpsRegex: this.authForm.trustedIpsRegex }) });
      if (r.ok) { await this.loadAuthStatus(); this.toast("信任 IP 正则已保存"); }
      else this.toast("保存失败", false);
    },
    async logout() {
      await fetch("/__auth/logout", { method:"POST" });
      location.href = "/";
    },
  };
}
</script>
</body>
</html>
```

- [ ] **Step 2: 手动烟雾测试**

```bash
MOCK_PORT=8799 bun run server.js &
sleep 1
curl -s http://localhost:8799/ | grep -o "网络与安全"
# 期望输出: 网络与安全
curl -s http://localhost:8799/ | grep -o "authForm"
# 期望输出至少一行: authForm
kill %1
rm -f mock.db
```

再在浏览器里打开 `http://localhost:8799/`（`MOCK_PORT=8799 bun run server.js` 手动跑一次，不放后台），确认：Tab 能切换；「网络与安全」里能看到 `http://localhost:8799` 和局域网 IP；设置密码后刷新页面看到登录页；输入密码能登录；退出登录后回到登录页。确认完 `Ctrl+C` 停掉，删掉这次产生的 `mock.db`。

- [ ] **Step 3: Commit**

```bash
git add panel.html
git commit -m "feat: panel.html 改 Tab 布局 + 新增网络与安全区块"
```

---

## Self-Review

**Spec 覆盖检查：**
- 保护范围（只挡控制台/管理接口，不挡 `/v1/*`）—— Task 6 Step 1 的 `authGated` 判断只匹配 `/` 和 `/__*`。✓
- 配置存 SQLite、面板可编辑 —— Task 1（store）+ Task 7（面板表单）。✓
- 环境变量作为启动引导覆盖 DB —— Task 6 Step 1 的 `MOCK_ADMIN_PASSWORD`/`MOCK_TRUSTED_IPS` 处理。✓
- 未设密码 = 现状不变 —— Task 5 `checkAccess` 的 `reason: "open"` 分支 + Task 1 默认值就是 `null`。✓
- 信任 IP 默认私网、自定义正则替换而非叠加 —— Task 2 `isTrustedIp` 实现 + 对应测试。✓
- 登录 + Session + 登出 —— Task 3。✓
- 限流 5 次/15 分钟 —— Task 4。✓
- 网络信息展示（本机/局域网地址 + 公网指引）—— Task 6 的 `lanIps()` + Task 7 的"网络与安全"卡片。✓
- 面板 Tab 化改版 —— Task 7。✓
- docker-compose.yml 环境变量示例 —— Task 6 Step 2。✓

**占位符扫描：** 全文没有 "TBD"/"实现细节后补"/裸的"加错误处理"这类描述，所有 Step 都是完整代码或精确命令+期望输出。

**类型/命名一致性检查：** `checkAccess` 返回的 `{ allowed, reason }`、`getAuthConfig` 返回的 `{ passwordHash, trustedIpsRegex, updatedAt }`、cookie 名 `mock_session` 在 Task 3/5/6 里保持一致；`/__auth/status` 响应字段 `passwordSet/authenticated/trustedByIp/trustedIpsRegex` 在 Task 6 和 Task 7 的 Alpine `auth` 对象里字段名完全对应。

**范围检查：** 8 个任务全部服务于同一个 spec，没有夹带不相关改动；未涉及 `formats/*`、`usage.js`、`presets.js`。
