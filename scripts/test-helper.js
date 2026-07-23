#!/usr/bin/env bun
// scripts/test-helper.js —— CLI 测试工具，跟 panel.html「Test」页签功能等价，
// 共享同一份核心逻辑(../testRunner.js)。向任意 OpenAI 兼容 endpoint (如 new-api) 发送测试请求。
//
// 用法:
//   bun scripts/test-helper.js --target=http://192.168.1.100:3000 --model=grok-4.5
//     [--format=openai] [--api-key=sk-xxx] [--prompt=...] [--stream] [--count=20] [--concurrency=5] [--verbose]
//
// --count=1 时自动额外打印完整响应体(单次模式)，跟面板「单次」切换按钮背后的行为一致。

import { runTest } from "../testRunner.js";

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

export async function main(argv) {
  const flags = parseArgs(argv);
  if (!flags.target || !flags.model) {
    console.error("用法: bun scripts/test-helper.js --target=http://... --model=grok-4.5 [--format=openai] [--api-key=sk-xxx] [--channel=主渠道] [--prompt=...] [--stream] [--count=20] [--concurrency=5] [--verbose]");
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

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error("\n" + e.message);
    process.exit(1);
  });
}
