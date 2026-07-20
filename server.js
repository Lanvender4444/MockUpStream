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
//   面板"网络与安全"区块可设置管理密码 + 信任 IP 正则，落库 mock.db（重启不丢，跟模型/预设一样）。
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
<title>Log In · mockupstream</title>
<style>
  @font-face { font-family:"JetBrains Mono"; src:url("/vendor/jetbrains-mono/JetBrainsMono-Regular.woff2") format("woff2"); font-weight:400; font-style:normal; font-display:swap; }
  @font-face { font-family:"JetBrains Mono"; src:url("/vendor/jetbrains-mono/JetBrainsMono-Medium.woff2") format("woff2"); font-weight:500; font-style:normal; font-display:swap; }
  @font-face { font-family:"JetBrains Mono"; src:url("/vendor/jetbrains-mono/JetBrainsMono-SemiBold.woff2") format("woff2"); font-weight:600; font-style:normal; font-display:swap; }
  :root { --bg:#1e1f22; --panel:#2b2d30; --border:#393b40; --fg:#dfe1e5; --mut:#8b8f97; --accent:#3574f0; --err:#db5c5c; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:var(--bg); color:var(--fg);
         font-family:"JetBrains Mono",ui-monospace,"Cascadia Code","SFMono-Regular",Consolas,monospace; font-size:12.5px; }
  form { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:0; width:340px; box-shadow:0 8px 32px rgba(0,0,0,.4); }
  .titlebar { padding:11px 16px; border-bottom:1px solid var(--border); color:var(--fg); font-size:12px; font-weight:600; }
  .body { padding:20px 20px 22px; }
  .sub { color:var(--mut); font-size:11.5px; margin:0 0 16px; }
  label { display:block; color:var(--mut); font-size:11px; margin-bottom:6px; text-transform:uppercase; letter-spacing:.05em; font-weight:600; }
  input { width:100%; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:5px;
          padding:8px 10px; font:12.5px "JetBrains Mono",ui-monospace,Consolas,monospace; margin-bottom:6px; }
  input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(53,116,240,.14); }
  .hint { color:var(--mut); font-size:11px; margin:0 0 16px; line-height:1.5; }
  button { width:100%; background:var(--accent); border:1px solid var(--accent); color:#fff; font-weight:500; padding:8px;
           border-radius:5px; cursor:pointer; font-family:inherit; font-size:12.5px; }
  button:hover { background:#4682f5; }
  .err { color:var(--err); font-size:12px; min-height:16px; margin:0 0 10px; }
</style></head>
<body>
<form id="f">
  <div class="titlebar">mockupstream</div>
  <div class="body">
    <p class="sub">控制台已启用密码保护</p>
    <div class="err" id="err"></div>
    <label for="pw">Password</label>
    <input type="password" id="pw" placeholder="••••••••" autocomplete="off" autofocus />
    <p class="hint">密码只经服务端 bcrypt 校验一次性传输，不写入 localStorage / Cookie 明文，浏览器也不会缓存这个值。</p>
    <button type="submit">Log In</button>
  </div>
</form>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const r = await fetch("/__auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }) });
  if (r.ok) { location.href = "/"; return; }
  if (r.status === 429) { const d = await r.json(); err.textContent = "失败次数过多，" + Math.ceil(d.retryAfterMs / 60000) + " 分钟后再试"; return; }
  err.textContent = "密码错误";
  document.getElementById("pw").value = "";
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
    const authExempt = p === "/__auth/login" || p === "/__auth/status" || p.startsWith("/vendor/");
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
        lan: cfg.lan,
        public: cfg.public,
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
      const body = await req.json().catch(() => ({}));
      const patch = {};
      if (body.password) patch.passwordHash = await auth.hashPassword(body.password);
      if (body.lan && typeof body.lan === "object") {
        patch.lan = {};
        if (auth.TRUST_MODES.includes(body.lan.mode)) patch.lan.mode = body.lan.mode;
        if (typeof body.lan.list === "string") patch.lan.list = body.lan.list.trim() || null;
      }
      if (body.public && typeof body.public === "object") {
        patch.public = {};
        if (auth.TRUST_MODES.includes(body.public.mode)) patch.public.mode = body.public.mode;
        if (typeof body.public.list === "string") patch.public.list = body.public.list.trim() || null;
      }
      const next = store.setAuthConfig(patch);
      return json({ ok: true, passwordSet: !!next.passwordHash, lan: next.lan, public: next.public });
    }

    // ---------- 控制台前端 ----------
    if (p === "/" || p === "/index.html")
      return new Response(Bun.file(import.meta.dir + "/panel.html"), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (p.startsWith("/vendor/")) {
      const rel = p.slice("/vendor/".length);
      if (rel.includes("..")) return new Response("forbidden", { status: 403 });
      const ext = rel.split(".").pop();
      const type = { js: "text/javascript", woff2: "font/woff2", txt: "text/plain" }[ext] || "application/octet-stream";
      const file = Bun.file(import.meta.dir + "/vendor/" + rel);
      if (!(await file.exists())) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "Content-Type": type } });
    }

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
