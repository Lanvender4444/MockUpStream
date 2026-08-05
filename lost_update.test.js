// lost_update.test.js —— bun test: 判定纯函数 judgeLostUpdate 的覆盖。
// 不打真实请求，只验证「before/afterCalibration/after + 计费条数 + 单次成本」到判定结果的映射。
import { test, expect } from "bun:test";
import { judgeLostUpdate } from "./lostUpdate.js";

const snap = (used, req) => ({ quota: 1000000, used_quota: used, request_count: req });

test("judgeLostUpdate: 全部对得上 → PASS", () => {
  const before = snap(1000, 10);
  const afterCal = snap(1100, 11);     // 校准 1 次，C = 100
  const after = snap(51100, 511);       // 又成功 500 次: +50000 used_quota, +500 req
  const r = judgeLostUpdate(before, afterCal, after, 500, 100);
  expect(r.ok).toBe(true);
  expect(r.verdict).toMatch(/PASS/);
  expect(r.usedExpected).toBe(50000);
  expect(r.usedActual).toBe(50000);
  expect(r.usedLost).toBe(0);
  expect(r.reqExpected).toBe(500);
  expect(r.reqActual).toBe(500);
  expect(r.reqLost).toBe(0);
});

test("judgeLostUpdate: used_quota 丢失 20% → FAIL", () => {
  // 旧版 User.Update 覆盖并发计费的典型场景
  const before = snap(1000, 10);
  const afterCal = snap(1100, 11);     // C = 100
  const after = snap(41100, 511);       // 应该 +50000，实际只 +40000（丢了 10000）
  const r = judgeLostUpdate(before, afterCal, after, 500, 100);
  expect(r.ok).toBe(false);
  expect(r.verdict).toMatch(/FAIL/);
  expect(r.usedExpected).toBe(50000);
  expect(r.usedActual).toBe(40000);
  expect(r.usedLost).toBe(10000);
  expect(r.usedPct).toBeCloseTo(20, 1);
  expect(r.reqLost).toBe(0); // request_count 这一路没丢
});

test("judgeLostUpdate: request_count 丢失 → FAIL", () => {
  const before = snap(1000, 10);
  const afterCal = snap(1100, 11);
  const after = snap(51100, 461);       // 应该 +500 req，实际只 +450（丢了 50）
  const r = judgeLostUpdate(before, afterCal, after, 500, 100);
  expect(r.ok).toBe(false);
  expect(r.reqExpected).toBe(500);
  expect(r.reqActual).toBe(450);
  expect(r.reqLost).toBe(50);
  expect(r.reqPct).toBeCloseTo(10, 1);
});

test("judgeLostUpdate: 容忍千分之五以内的浮点误差（仍 PASS）", () => {
  // GORM quota 是整数，但仍给一点缓冲
  const before = snap(1000, 10);
  const afterCal = snap(1100, 11);
  // 500 * 100 = 50000 期望, 实际 +49950（差 50，0.1% < 0.5% 容忍）→ after.used_quota = 1100+49950 = 51050
  const after = snap(51050, 511);
  const r = judgeLostUpdate(before, afterCal, after, 500, 100);
  expect(r.ok).toBe(true);
  expect(r.usedLost).toBe(50);
  expect(r.usedPct).toBeCloseTo(0.1, 2);
});

test("judgeLostUpdate: 计费 0 成功（计费流全挂） → PASS（不是 lost-update 问题）", () => {
  const before = snap(1000, 10);
  const afterCal = snap(1100, 11);
  const after = snap(1100, 11); // 没有任何计费请求成功
  const r = judgeLostUpdate(before, afterCal, after, 0, 100);
  expect(r.ok).toBe(true);
  expect(r.usedExpected).toBe(0);
  expect(r.reqExpected).toBe(0);
});

test("judgeLostUpdate: 缺字段时安全降级（不抛错），实际视为 FAIL", () => {
  const r = judgeLostUpdate(null, null, null, 100, 50);
  expect(r.usedExpected).toBe(5000);
  expect(r.usedActual).toBe(0);
  expect(r.usedLost).toBe(5000);
  expect(r.reqExpected).toBe(100);
  expect(r.reqActual).toBe(0);
  expect(r.reqLost).toBe(100);
  expect(r.ok).toBe(false);
  expect(r.verdict).toMatch(/FAIL/);
});
