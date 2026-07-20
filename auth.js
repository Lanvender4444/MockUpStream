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
