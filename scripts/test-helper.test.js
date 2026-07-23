// scripts/test-helper.test.js —— bun test: CLI 测试脚本的参数解析 + 目标解析(不测 process.exit/网络)。
import { test, expect } from "bun:test";
import { parseArgs, validateCounts } from "./test-helper.js";

test("parseArgs: --key=value 解析成 flags 对象", () => {
  const flags = parseArgs(["--model=grok-4.5", "--host=192.168.1.50", "--stream", "--count=50"]);
  expect(flags.model).toBe("grok-4.5");
  expect(flags.host).toBe("192.168.1.50");
  expect(flags.stream).toBe(true); // 无值的 --flag 形式 -> true(布尔开关)
  expect(flags.count).toBe("50");
});

test("validateCounts: count/concurrency 在范围内返回 {count, concurrency}(数字)", () => {
  const r = validateCounts({ count: "20", concurrency: "5" });
  expect(r).toEqual({ count: 20, concurrency: 5 });
});

test("validateCounts: count 未指定时默认 20, concurrency 默认 5", () => {
  const r = validateCounts({});
  expect(r).toEqual({ count: 20, concurrency: 5 });
});

test("validateCounts: count 超过 1000 抛错", () => {
  expect(() => validateCounts({ count: "5000" })).toThrow(/count/);
});

test("validateCounts: concurrency 超过 50 抛错", () => {
  expect(() => validateCounts({ concurrency: "999" })).toThrow(/concurrency/);
});

test("validateCounts: count 是 0 或负数抛错", () => {
  expect(() => validateCounts({ count: "0" })).toThrow(/count/);
});
