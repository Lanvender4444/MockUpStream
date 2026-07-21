// tls.test.js —— bun test: HTTPS 证书路径解析(两个环境变量都给 + 文件都存在才启用，否则安静退回 HTTP)。
import { test, expect } from "bun:test";
import { resolveTls } from "./tls.js";

test("resolveTls: 两个环境变量都没给 -> null(退回 HTTP)", () => {
  expect(resolveTls({}, () => true)).toBeNull();
});

test("resolveTls: 只给了 cert 没给 key -> null", () => {
  expect(resolveTls({ MOCK_TLS_CERT: "/a/cert.pem" }, () => true)).toBeNull();
});

test("resolveTls: 两个都给了但文件不存在 -> null", () => {
  const exists = () => false;
  expect(resolveTls({ MOCK_TLS_CERT: "/a/cert.pem", MOCK_TLS_KEY: "/a/key.pem" }, exists)).toBeNull();
});

test("resolveTls: 两个都给了且文件都存在 -> 返回路径", () => {
  const exists = () => true;
  const env = { MOCK_TLS_CERT: "/a/cert.pem", MOCK_TLS_KEY: "/a/key.pem" };
  expect(resolveTls(env, exists)).toEqual({ certPath: "/a/cert.pem", keyPath: "/a/key.pem" });
});

test("resolveTls: 只有 cert 文件存在、key 文件不存在 -> null", () => {
  const exists = (p) => p === "/a/cert.pem";
  const env = { MOCK_TLS_CERT: "/a/cert.pem", MOCK_TLS_KEY: "/a/key.pem" };
  expect(resolveTls(env, exists)).toBeNull();
});
