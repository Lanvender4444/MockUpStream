#!/usr/bin/env bun
// scripts/test-helper.js —— CLI 测试工具，跟 panel.html「Test」页签功能等价，
// 共享同一份核心逻辑(../testRunner.js)。向任意 OpenAI 兼容 endpoint (如 new-api) 发送测试请求。
//
// 用法:
//   bun scripts/test-helper.js --target=http://192.168.1.100:3000 --model=grok-4.5
//     [--format=openai] [--api-key=sk-xxx] [--prompt=...] [--stream] [--count=20] [--concurrency=5] [--verbose]
//
// 丢失更新漏洞测试(测 new-api user.Update 覆盖并发计费)：
//   bun scripts/test-helper.js --test-type=lost_update --target=http://localhost:3000 \
//     --model=gpt-3.5-turbo --api-key=sk-被测用户token \
//     --lu-user-id=3 --lu-admin-user=root --lu-admin-pass=123456 \
//     [--lu-admin-url=http://localhost:3000] [--lu-path=self|token|setting] \
//     [--count=500] [--concurrency=6] [--lu-profile-count=5000] [--lu-profile-concurrency=3]
//
// --count=1 时自动额外打印完整响应体(单次模式)，跟面板「单次」切换按钮背后的行为一致。

import { runTest } from "../testRunner.js";
import { runLostUpdateTest } from "../lostUpdate.js";

export function parseArgs(argv) {
  const flags = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) { flags[m[1]] = m[2]; continue; }
    const bare = arg.match(/^--([^=]+)$/);
    if (bare) flags[bare[1]] = true;
  }
  return flags;
}

export function validateCounts(flags) {
  const count = flags.count != null ? Number(flags.count) : 20;
  const concurrency = flags.concurrency != null ? Number(flags.concurrency) : 5;
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error(`count 必须是 1-1000 的整数，收到: ${flags.count}`);
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) {
    throw new Error(`concurrency 必须是 1-50 的整数，收到: ${flags.concurrency}`);
  }
  return { count, concurrency };
}

function printProgress(sent, total, success, fail) {
  process.stdout.write(`\r已发 ${sent}/${total}  成功 ${success}  失败 ${fail}`);
}

function printSummary(summary, streamMode) {
  console.log("\n\n汇总:");
  console.log(`  总数 ${summary.total}  成功 ${summary.success}  失败 ${summary.fail}`);
  console.log("  按状态分组:");
  for (const [status, cnt] of Object.entries(summary.byStatus)) {
    console.log(`    ${status}: ${cnt}`);
  }
  const l = summary.latency;
  console.log(`  延迟(ms，仅统计成功请求${streamMode ? "，流式为首包延迟" : ""}): min=${l.min} avg=${l.avg} max=${l.max} p95=${l.p95}`);
}

function printDetail(requests) {
  console.log("\n逐条明细:");
  for (const r of requests) {
    const ch = r.channel ? `  channel=${r.channel}` : "";
    console.log(`  #${r.index + 1}  ${r.ok ? "OK " : "ERR"}  status=${r.status}  ${r.latencyMs}ms${ch}`);
  }
}

function printBody(raw) {
  console.log("\n完整响应:");
  if (!raw) { console.log("(空)"); return; }
  try {
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    console.log(raw);
  }
}

function printLostUpdateResult(lu) {
  console.log("\n丢失更新判定:");
  console.log(`  计费流  ${lu.billing.ok}/${lu.billing.total} 成功`);
  console.log(`  资料流  ${lu.profile.ok}/${lu.profile.total} 成功  (路径 ${lu.luPath})`);
  console.log(`  单次成本 C = ${lu.C}`);
  console.log("  ┌──────────────┬──────────┬──────────┬──────────┬───────────┐");
  console.log("  │ 指标         │ 期望     │ 实际     │ 丢失     │ 丢失率    │");
  console.log("  ├──────────────┼──────────┼──────────┼──────────┼───────────┤");
  const row = (label, e, a, l, p) => {
    const pad = (s, n) => String(s).padEnd(n);
    console.log(`  │ ${pad(label, 12)} │ ${pad(e, 8)} │ ${pad(a, 8)} │ ${pad(l, 8)} │ ${pad(p, 9)} │`);
  };
  row("used_quota", lu.usedExpected, lu.usedActual, lu.usedLost, lu.usedPct.toFixed(2) + "%");
  row("request_cnt", lu.reqExpected, lu.reqActual, lu.reqLost, lu.reqPct.toFixed(2) + "%");
  console.log("  └──────────────┴──────────┴──────────┴──────────┴───────────┘");
  console.log(`  结论: ${lu.verdict}`);
}

export async function main(argv) {
  const flags = parseArgs(argv);
  if (flags["test-type"] === "lost_update") {
    return runLostUpdateMode(flags);
  }
  if (!flags.target || !flags.model) {
    console.error("用法: bun scripts/test-helper.js --target=http://... --model=grok-4.5 [--format=openai] [--api-key=sk-xxx] [--channel=主渠道] [--prompt=...] [--stream] [--count=20] [--concurrency=5] [--verbose]");
    console.error("丢失更新: 加 --test-type=lost_update --lu-user-id=N --api-key=sk-被测用户token");
    process.exit(1);
  }

  const { count, concurrency } = validateCounts(flags);

  let sent = 0, success = 0, fail = 0;
  const baseUrl = flags.target.replace(/\/+$/, "");
  const captureBody = count === 1;
  const { summary, requests } = await runTest(
    {
      baseUrl,
      format: flags.format || "openai",
      model: flags.model,
      token: flags["api-key"] || "",
      prompt: flags.prompt || "",
      stream: !!flags.stream,
      count,
      concurrency,
      captureBody,
      channel: flags.channel || "",
    },
    (evt) => {
      if (evt.type === "progress") {
        sent++;
        if (evt.ok) success++; else fail++;
        printProgress(sent, count, success, fail);
      }
    }
  );

  printSummary(summary, !!flags.stream);
  if (captureBody && requests[0]) printBody(requests[0].body);
  if (flags.verbose) printDetail(requests);
}

async function runLostUpdateMode(flags) {
  if (!flags.target || !flags.model) {
    console.error("丢失更新测试需要: --target --model --api-key --lu-user-id");
    process.exit(1);
  }
  if (!flags["lu-user-id"]) {
    console.error("需要 --lu-user-id（被测用户 id，在 new-api 后台手动建好）");
    process.exit(1);
  }
  if (!flags["api-key"]) {
    console.error("需要 --api-key（被测用户自己的系统令牌 sk-xxx）");
    process.exit(1);
  }
  const count = Number(flags.count || 500);
  const concurrency = Number(flags.concurrency || 6);
  const luProfileCount = Number(flags["lu-profile-count"] || 5000);
  const luProfileConcurrency = Number(flags["lu-profile-concurrency"] || 3);
  console.log(`丢失更新漏洞测试 → ${flags.target}`);
  console.log(`  计费流  ${count} 条 (并发 ${concurrency})`);
  console.log(`  资料流  ${luProfileCount} 次 (并发 ${luProfileConcurrency}, 路径 ${flags["lu-path"] || "self"})`);
  console.log(`  被测用户  id=${flags["lu-user-id"]}  管理员=${flags["lu-admin-user"] || "root"}`);

  let lastPhase = "";
  const push = (evt) => {
    if (evt.type === "phase") {
      console.log("\n[" + evt.phase + "] " + evt.message);
      lastPhase = evt.message;
    } else if (evt.type === "billingProgress") {
      process.stdout.write(`\r  计费 ${evt.done}/${evt.total} (${evt.ok ? "OK" : "ERR " + evt.status})  `);
    } else if (evt.type === "profileProgress") {
      process.stdout.write(`\r  资料 ${evt.done}/${evt.total} (ok ${evt.ok} / fail ${evt.fail})    `);
    } else if (evt.type === "billingDone") {
      console.log("\n  计费流完成: 成功 " + evt.summary.success + " / 失败 " + evt.summary.fail);
    } else if (evt.type === "done") {
      process.stdout.write("\r" + " ".repeat(80) + "\r");
      if (evt.lostUpdate) printLostUpdateResult(evt.lostUpdate);
    } else if (evt.type === "error") {
      console.error("\n错误: " + evt.message);
    }
  };

  await runLostUpdateTest(
    {
      targetUrl: flags.target,
      model: flags.model,
      format: flags.format || "openai",
      apiKey: flags["api-key"],
      prompt: flags.prompt || "",
      stream: !!flags.stream,
      count,
      concurrency,
      luAdminUrl: flags["lu-admin-url"] || "",
      luAdminUser: flags["lu-admin-user"] || "root",
      luAdminPass: flags["lu-admin-pass"] || "123456",
      luUserId: String(flags["lu-user-id"]),
      luPath: flags["lu-path"] || "self",
      luProfileConcurrency,
      luProfileCount,
    },
    push
  );
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("\n" + e.message);
    process.exit(1);
  });
}
