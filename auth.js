// auth.js —— 局域网/公网访问身份验证：IP 信任判断、密码哈希、session、限流。
// 不依赖 store.js（配置以参数传入），方便单测。

export const DEFAULT_PRIVATE_IP_REGEX_SOURCE =
  "^(127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|::1$|::ffff:127\\.|::ffff:10\\.|::ffff:192\\.168\\.)";

export function getClientIp(req, server) {
  const addr = server && typeof server.requestIP === "function" ? server.requestIP(req) : null;
  return (addr && addr.address) || "unknown";
}

export function isTrustedIp(ip, authConfig) {
  const source = (authConfig && authConfig.trustedIpsRegex) || DEFAULT_PRIVATE_IP_REGEX_SOURCE;
  let re;
  try { re = new RegExp(source); } catch { re = new RegExp(DEFAULT_PRIVATE_IP_REGEX_SOURCE); }
  return re.test(ip);
}

export async function hashPassword(password) {
  return Bun.password.hash(password);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  try { return await Bun.password.verify(password, hash); } catch { return false; }
}

const sessions = new Map(); // token -> createdAt(ms)
const SESSION_COOKIE_NAME = "mock_session";

export function createSession() {
  const token = crypto.randomUUID();
  sessions.set(token, Date.now());
  return token;
}

function getSessionToken(req) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.split(";").map((s) => s.trim()).find((s) => s.startsWith(SESSION_COOKIE_NAME + "="));
  return match ? match.slice(SESSION_COOKIE_NAME.length + 1) : null;
}

export function hasValidSession(req) {
  const token = getSessionToken(req);
  return !!token && sessions.has(token);
}

export function destroySession(req) {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
}

export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookieHeader() {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

const loginAttempts = new Map(); // ip -> { fails, lockedUntil }
const MAX_LOGIN_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

export function isLocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || !rec.lockedUntil) return 0;
  const remain = rec.lockedUntil - Date.now();
  if (remain <= 0) { loginAttempts.delete(ip); return 0; }
  return remain;
}

export function recordFailure(ip) {
  const rec = loginAttempts.get(ip) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_LOGIN_FAILS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.fails = 0; }
  loginAttempts.set(ip, rec);
}

export function recordSuccess(ip) {
  loginAttempts.delete(ip);
}
