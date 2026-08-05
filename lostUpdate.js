// lostUpdate.js —— lost-update 漏洞测试的后端执行逻辑 + 判定纯函数。
// 由 server.js 的 POST /__test/lost-update 调用。
// 仿照 testRunner.js 的 onEvent(progress|done|error) 流式事件模型。

import * as testRunner from "./testRunner.js";

const TIMEOUT_MS = 30000;

// ---------- 判定纯函数（单元测试可直接 import 这个）----------
// 入参：before/afterCalibration/after = { quota, used_quota, request_count } 快照；
//       billingOk = 计费流实际成功的条数；C = 单次计费请求的 used_quota 成本。
// 返回 { ok, usedExpected, usedActual, usedLost, usedPct, reqExpected, reqActual, reqLost, reqPct, verdict }
export function judgeLostUpdate(before, afterCalibration, after, billingOk, C) {
  const usedExpected = Math.round(billingOk * C);
  const usedActual =
    Number(after?.used_quota ?? 0) - Number(afterCalibration?.used_quota ?? 0);
  const reqExpected = billingOk;
  const reqActual =
    Number(after?.request_count ?? 0) - Number(afterCalibration?.request_count ?? 0);
  const usedLost = Math.max(0, usedExpected - usedActual);
  const reqLost = Math.max(0, reqExpected - reqActual);
  const usedPct = usedExpected > 0 ? (usedLost / usedExpected) * 100 : 0;
  const reqPct = reqExpected > 0 ? (reqLost / reqExpected) * 100 : 0;
  // 容忍万分之五的浮点误差(GORM quota 是整数 integer，但仍给点缓冲)
  const usedOk = usedLost <= Math.max(1, usedExpected * 0.005);
  const reqOk = reqLost <= 1;
  return {
    ok: usedOk && reqOk,
    usedExpected, usedActual, usedLost, usedPct,
    reqExpected, reqActual, reqLost, reqPct,
    verdict: usedOk && reqOk ? "PASS / 已修复" : "FAIL / BUG 暴露",
  };
}

// ---------- 内部辅助 ----------
async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// 拷出 set-cookie 里的 session 值（new-api 用 session=xxx 一条就够）。
function grabSessionCookie(res) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  for (const c of list) {
    const m = c.match(/session=([^;]+)/);
    if (m) return "session=" + m[1];
  }
  // 兜底：从单个 set-cookie header 拆
  const single = res.headers.get("set-cookie");
  if (single) {
    const m = single.match(/session=([^;]+)/);
    if (m) return "session=" + m[1];
  }
  return "";
}

async function login(adminUrl, username, password) {
  const res = await fetchWithTimeout(adminUrl + "/api/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(`登录失败: HTTP ${res.status}`);
  const data = await res.json().catch(() => ({}));
  if (data.success === false) throw new Error("登录失败: " + (data.message || "未知错误"));
  const cookie = grabSessionCookie(res);
  if (!cookie) throw new Error("登录返回没有 session cookie，无法继续读用户状态");
  return cookie;
}

async function getUserState(adminUrl, userId, sessionCookie) {
  const res = await fetchWithTimeout(`${adminUrl}/api/user/${userId}`, {
    headers: { Cookie: sessionCookie },
  });
  if (!res.ok) throw new Error(`读取用户 HTTP ${res.status}`);
  const body = await res.json().catch(() => ({}));
  if (body.success === false) throw new Error("读取用户: " + (body.message || "未知错误"));
  const u = body.data || {};
  return {
    quota: Number(u.quota ?? 0),
    used_quota: Number(u.used_quota ?? 0),
    request_count: Number(u.request_count ?? 0),
  };
}

// 单条资料更新请求：根据 luPath 选不同路径触发同一个 Update() 坏方法。
async function sendProfileUpdate(billingUrl, luPath, apiKey, idx) {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (luPath === "self") {
    const v = "v" + (idx % 2);
    const res = await fetchWithTimeout(billingUrl + "/api/user/self", {
      method: "PUT",
      headers,
      body: JSON.stringify({ sidebar_modules: v }),
    }, 15000);
    return res.ok;
  }
  if (luPath === "token") {
    const res = await fetchWithTimeout(billingUrl + "/api/user/token", { headers }, 15000);
    return res.ok;
  }
  if (luPath === "setting") {
    // 空 body 触发默认 settings 复位 + Update()；不丢失任何 settings 的语义，单纯触发漏洞路径
    const res = await fetchWithTimeout(billingUrl + "/api/user/setting", {
      method: "PUT",
      headers,
      body: JSON.stringify({}),
    }, 15000);
    return res.ok;
  }
  throw new Error("未知 luPath: " + luPath);
}

// 资料流 worker pool，跟 testRunner.runTest 一样的"每条完成即推一条 progress"风格。
async function runProfileStream(billingUrl, luPath, apiKey, total, concurrency, onProgress) {
  let next = 0;
  let ok = 0;
  let fail = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      try {
        const r = await sendProfileUpdate(billingUrl, luPath, apiKey, i);
        if (r) ok++; else fail++;
      } catch {
        fail++;
      }
      onProgress({ ok, fail, done: ok + fail, total });
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  await Promise.all(workers);
  return { ok, fail, total };
}

// ---------- 主入口 ----------
export async function runLostUpdateTest(b, push) {
  const targetUrl = (b.targetUrl || "").replace(/\/+$/, "");
  const adminUrl = (b.luAdminUrl || b.targetUrl || "").replace(/\/+$/, "");
  if (!targetUrl) throw new Error("请填写目标地址(targetUrl)");
  if (!adminUrl) throw new Error("请填写 new-api 管理地址(luAdminUrl 或 targetUrl)");
  if (!b.apiKey) throw new Error("请填入被测用户自己的系统令牌(apiKey)");
  if (!b.luUserId) throw new Error("请填入被测用户 ID(luUserId)");
  const count = Number(b.count);
  const concurrency = Number(b.concurrency);
  const luProfileCount = Number(b.luProfileCount);
  const luProfileConcurrency = Number(b.luProfileConcurrency);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("计费条数必须是 1-1000 的整数");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 50) throw new Error("计费并发必须是 1-50 的整数");
  if (!Number.isInteger(luProfileCount) || luProfileCount < 1 || luProfileCount > 100000) throw new Error("资料更新次数必须是 1-100000 的整数");
  if (!Number.isInteger(luProfileConcurrency) || luProfileConcurrency < 1 || luProfileConcurrency > 50) throw new Error("资料并发必须是 1-50 的整数");
  const luPath = b.luPath || "self";

  push({ type: "phase", phase: "login", message: `登录 ${b.luAdminUser || "root"} ...` });
  const session = await login(adminUrl, b.luAdminUser || "root", b.luAdminPass || "123456");

  push({ type: "phase", phase: "baseline", message: "读取计费前用户状态 ..." });
  const before = await getUserState(adminUrl, b.luUserId, session);

  // 校准：1 次计费请求，测单次成本 C
  push({ type: "phase", phase: "calibrate", message: "发 1 次计费请求测单次成本 ..." });
  let calSummary;
  let calRequests;
  ({ summary: calSummary, requests: calRequests } = await testRunner.runTest(
    {
      baseUrl: targetUrl,
      format: b.format || "openai",
      model: b.model,
      token: b.apiKey || "",
      prompt: b.prompt || "",
      stream: !!b.stream,
      count: 1,
      concurrency: 1,
      captureBody: false,
      channel: "",
    },
    () => {}
  ));
  let afterCalibration;
  try { afterCalibration = await getUserState(adminUrl, b.luUserId, session); }
  catch (e) { throw new Error("校准后读取用户失败: " + e.message); }
  const C = afterCalibration.used_quota - before.used_quota;
  if (C <= 0) {
    throw new Error(
      `校准成本为 0（before.used_quota=${before.used_quota} → after=${afterCalibration.used_quota}）。可能：①模型倍率未配置；②chat 请求没成功；③渠道没指向 mock。`
    );
  }

  // 并发跑两条流
  push({ type: "phase", phase: "hammer", message: `开始压测：${count} 条计费(并发 ${concurrency}) × ${luProfileCount} 次资料更新(并发 ${luProfileConcurrency})` });

  let billingSummary = null;
  let profileResult = null;

  // 计费流：复用 testRunner.runTest，进度透传成 progress 事件
  const billingPromise = testRunner.runTest(
    {
      baseUrl: targetUrl,
      format: b.format || "openai",
      model: b.model,
      token: b.apiKey || "",
      prompt: b.prompt || "",
      stream: !!b.stream,
      count,
      concurrency,
      captureBody: false,
      channel: "",
    },
    (evt) => {
      if (evt.type === "progress") {
        push({ type: "billingProgress", ok: evt.ok, status: evt.status, done: evt.index + 1, total: count });
      } else if (evt.type === "done") {
        billingSummary = evt.summary;
        push({ type: "billingDone", summary: evt.summary });
      }
    }
  );

  // 资料流：自己的 worker pool
  const profilePromise = runProfileStream(targetUrl, luPath, b.apiKey, luProfileCount, luProfileConcurrency, (p) => {
    push({ type: "profileProgress", ...p });
  });

  [, profileResult] = await Promise.all([billingPromise, profilePromise]);

  push({ type: "phase", phase: "settle", message: "读取计费后用户状态 ..." });
  const after = await getUserState(adminUrl, b.luUserId, session);

  const judge = judgeLostUpdate(before, afterCalibration, after, billingSummary?.success || 0, C);
  push({
    type: "done",
    summary: billingSummary,
    lostUpdate: {
      ...judge,
      before,
      afterCalibration,
      after,
      C,
      billing: { total: count, ok: billingSummary?.success || 0, fail: billingSummary?.fail || 0 },
      profile: profileResult,
      luPath,
      profileCount: luProfileCount,
    },
  });
}