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
