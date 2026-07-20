// auth.test.js —— bun test: 局域网/公网访问身份验证（store 持久化 + auth.js 逻辑）。
import { test, expect, beforeEach } from "bun:test";
import * as store from "./store.js";
import * as auth from "./auth.js";

beforeEach(async () => {
  await store.load(":memory:");
});

test("getAuthConfig: 初始状态密码为 null, 局域网默认全开, 公网默认白名单(空)", () => {
  const cfg = store.getAuthConfig();
  expect(cfg.passwordHash).toBeNull();
  expect(cfg.lan).toEqual({ mode: "allow-all", list: null });
  expect(cfg.public).toEqual({ mode: "whitelist", list: null });
});

test("setAuthConfig: 写入密码 hash 后能读回, 不影响信任策略默认值", () => {
  store.setAuthConfig({ passwordHash: "fake-hash-value" });
  const cfg = store.getAuthConfig();
  expect(cfg.passwordHash).toBe("fake-hash-value");
  expect(cfg.lan.mode).toBe("allow-all");
  expect(cfg.public.mode).toBe("whitelist");
});

test("setAuthConfig: 局域网/公网策略各自独立写入, 互不覆盖, 也不影响密码", () => {
  store.setAuthConfig({ passwordHash: "fake-hash-value" });
  store.setAuthConfig({ lan: { mode: "whitelist", list: "^192\\.168\\.1\\." } });
  store.setAuthConfig({ public: { mode: "blacklist", list: "^203\\.0\\.113\\.9$" } });
  const cfg = store.getAuthConfig();
  expect(cfg.passwordHash).toBe("fake-hash-value");
  expect(cfg.lan).toEqual({ mode: "whitelist", list: "^192\\.168\\.1\\." });
  expect(cfg.public).toEqual({ mode: "blacklist", list: "^203\\.0\\.113\\.9$" });
});

test("isPrivateIp: 私网/回环地址判定", () => {
  expect(auth.isPrivateIp("127.0.0.1")).toBe(true);
  expect(auth.isPrivateIp("192.168.1.20")).toBe(true);
  expect(auth.isPrivateIp("10.0.0.5")).toBe(true);
  expect(auth.isPrivateIp("172.20.0.9")).toBe(true);
  expect(auth.isPrivateIp("8.8.8.8")).toBe(false);
  expect(auth.isPrivateIp("203.0.113.9")).toBe(false);
});

test("isTrustedIp: 局域网默认 allow-all, 任意私网地址都放行", () => {
  const cfg = { lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: null } };
  expect(auth.isTrustedIp("127.0.0.1", cfg)).toBe(true);
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(true);
});

test("isTrustedIp: 公网默认 whitelist 且为空, 公网地址一律不信任", () => {
  const cfg = { lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: null } };
  expect(auth.isTrustedIp("8.8.8.8", cfg)).toBe(false);
  expect(auth.isTrustedIp("203.0.113.9", cfg)).toBe(false);
});

test("isTrustedIp: 局域网 deny-all 时私网地址也要登录", () => {
  const cfg = { lan: { mode: "deny-all", list: null }, public: { mode: "whitelist", list: null } };
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(false);
});

test("isTrustedIp: 局域网 whitelist 只放行命中的网段", () => {
  const cfg = { lan: { mode: "whitelist", list: "^192\\.168\\.1\\." }, public: { mode: "whitelist", list: null } };
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(true);
  expect(auth.isTrustedIp("192.168.2.20", cfg)).toBe(false); // 私网但没命中白名单, 私网默认放行不再生效
});

test("isTrustedIp: 局域网 blacklist 放行除命中规则外的所有私网地址", () => {
  const cfg = { lan: { mode: "blacklist", list: "^192\\.168\\.2\\." }, public: { mode: "whitelist", list: null } };
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(true);
  expect(auth.isTrustedIp("192.168.2.20", cfg)).toBe(false);
});

test("isTrustedIp: 公网 whitelist 命中的 IP 被信任, 不影响局域网默认放行(两条策略独立)", () => {
  const cfg = { lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: "^203\\.0\\.113\\.9$" } };
  expect(auth.isTrustedIp("203.0.113.9", cfg)).toBe(true);   // 公网白名单命中
  expect(auth.isTrustedIp("192.168.1.20", cfg)).toBe(true);  // 局域网默认放行依然生效
  expect(auth.isTrustedIp("8.8.8.9", cfg)).toBe(false);      // 没在白名单里的公网地址仍不信任
});

test("isTrustedIp: 公网 allow-all 时任意公网地址都放行(不推荐但支持)", () => {
  const cfg = { lan: { mode: "allow-all", list: null }, public: { mode: "allow-all", list: null } };
  expect(auth.isTrustedIp("8.8.8.8", cfg)).toBe(true);
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

test("checkAccess: 未设置密码 => 直接放行(reason=open)", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "8.8.8.8" }) };
  const result = auth.checkAccess(req, server, { passwordHash: null, lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: null } });
  expect(result).toEqual({ allowed: true, reason: "open" });
});

test("checkAccess: 设置密码 + 信任 IP => 放行(reason=trusted-ip)", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "192.168.1.5" }) };
  const result = auth.checkAccess(req, server, { passwordHash: "h", lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: null } });
  expect(result).toEqual({ allowed: true, reason: "trusted-ip" });
});

test("checkAccess: 设置密码 + 非信任 IP + 无 session => 拒绝", () => {
  const req = new Request("http://x/");
  const server = { requestIP: () => ({ address: "8.8.8.8" }) };
  const result = auth.checkAccess(req, server, { passwordHash: "h", lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: null } });
  expect(result).toEqual({ allowed: false, reason: "unauthenticated" });
});

test("checkAccess: 设置密码 + 非信任 IP + 有效 session => 放行(reason=session)", () => {
  const token = auth.createSession();
  const req = new Request("http://x/", { headers: { cookie: `mock_session=${token}` } });
  const server = { requestIP: () => ({ address: "8.8.8.8" }) };
  const result = auth.checkAccess(req, server, { passwordHash: "h", lan: { mode: "allow-all", list: null }, public: { mode: "whitelist", list: null } });
  expect(result).toEqual({ allowed: true, reason: "session" });
});
