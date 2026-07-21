// tls.js —— HTTPS 证书路径解析。
// 局域网/自用场景：用 scripts/gen-cert.sh 生成自签证书，走 MOCK_TLS_CERT / MOCK_TLS_KEY 两个环境变量启用。
// 公网 + 域名场景：推荐 Caddy/nginx 反代终止 HTTPS，mock 本身留明文 HTTP 即可(见 Caddyfile.example)，
// 不建议把自签证书暴露在公网——浏览器会一直报不可信，且自签证书没有真正的身份校验意义。
import { existsSync } from "node:fs";

// 两个环境变量都给了、且文件都存在，才启用 TLS；否则安静地退回明文 HTTP —— 本地/开发默认体验不变，不因为忘配证书而直接起不来。
export function resolveTls(env = process.env, exists = existsSync) {
  const certPath = env.MOCK_TLS_CERT;
  const keyPath = env.MOCK_TLS_KEY;
  if (!certPath || !keyPath) return null;
  if (!exists(certPath) || !exists(keyPath)) return null;
  return { certPath, keyPath };
}
