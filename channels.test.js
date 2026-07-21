// channels.test.js —— bun test: 渠道 CRUD + 种子数据 + 门禁逻辑(store.js + usage.js)。
import { test, expect, beforeEach } from "bun:test";
import * as store from "./store.js";
import { shouldChannelFail } from "./usage.js";

beforeEach(async () => {
  await store.load(":memory:");
});

test("首次建库自动 seed 3 个示例渠道", () => {
  const { channels } = store.getState();
  expect(channels.length).toBe(3);
  const ids = channels.map((c) => c.id);
  expect(ids).toEqual(["primary", "backup", "flaky"]);
});

test("种子渠道字段符合典型测试场景", () => {
  const { channels } = store.getState();
  const backup = channels.find((c) => c.id === "backup");
  expect(backup.extraLatencyMs).toBe(800);
  expect(backup.enabled).toBe(1);
  const flaky = channels.find((c) => c.id === "flaky");
  expect(flaky.errorRate).toBe(30);
});

test("upsertChannel: 新建 + 数字字段兜底", async () => {
  const saved = await store.upsertChannel({ id: "ch1", name: "测试渠道", errorRate: "50" });
  expect(saved.id).toBe("ch1");
  expect(saved.errorRate).toBe(50);
  expect(saved.enabled).toBe(1); // 没给, 用默认值
  expect(saved.extraLatencyMs).toBe(0);
});

test("upsertChannel: 同 id 更新而不是重复插入", async () => {
  await store.upsertChannel({ id: "ch2", name: "A" });
  await store.upsertChannel({ id: "ch2", name: "B", enabled: 0 });
  const c = store.getChannel("ch2");
  expect(c.name).toBe("B");
  expect(c.enabled).toBe(0);
  expect(store.getState().channels.filter((x) => x.id === "ch2").length).toBe(1);
});

test("getChannel: 查无此渠道返回 null", () => {
  expect(store.getChannel("no-such-channel")).toBeNull();
});

test("deleteChannel: 删除后查不到", async () => {
  await store.upsertChannel({ id: "ch3" });
  await store.deleteChannel("ch3");
  expect(store.getChannel("ch3")).toBeNull();
});

test("reset(): 渠道也回到 3 个种子渠道", async () => {
  await store.upsertChannel({ id: "extra" });
  expect(store.getState().channels.length).toBe(4);
  await store.reset();
  expect(store.getState().channels.length).toBe(3);
});

test("shouldChannelFail: channel 为 null(无渠道前缀直连) 恒不失败", () => {
  expect(shouldChannelFail(null)).toBe(false);
});

test("shouldChannelFail: enabled=0 恒失败", () => {
  expect(shouldChannelFail({ enabled: 0, errorRate: 0 })).toBe(true);
});

test("shouldChannelFail: enabled=1 且 errorRate=0 恒不失败", () => {
  for (let i = 0; i < 50; i++) expect(shouldChannelFail({ enabled: 1, errorRate: 0 }, Math.random)).toBe(false);
});

test("shouldChannelFail: enabled=1 且 errorRate=100 恒失败", () => {
  for (let i = 0; i < 50; i++) expect(shouldChannelFail({ enabled: 1, errorRate: 100 }, Math.random)).toBe(true);
});

test("shouldChannelFail: 用固定 rand() 精确验证边界", () => {
  const channel = { enabled: 1, errorRate: 30 };
  expect(shouldChannelFail(channel, () => 0.29)).toBe(true);  // 29 < 30
  expect(shouldChannelFail(channel, () => 0.30)).toBe(false); // 30 !< 30
});
