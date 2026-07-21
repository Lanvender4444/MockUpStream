// scripts/start-https.js —— `bun run https` 的入口：用默认路径 certs/cert.pem + certs/key.pem
// 把两个 TLS 环境变量设好再拉起 server.js，省得每次手动 export/$env: 那两行。
// 证书不存在就提示先跑 gen-cert.sh，不瞎造一个假证书出来。
import { existsSync } from "node:fs";

const CERT = process.env.MOCK_TLS_CERT || "certs/cert.pem";
const KEY = process.env.MOCK_TLS_KEY || "certs/key.pem";

if (!existsSync(CERT) || !existsSync(KEY)) {
  console.error(`证书不存在: ${CERT} / ${KEY}`);
  console.error(`先生成一次: bash scripts/gen-cert.sh`);
  process.exit(1);
}

process.env.MOCK_TLS_CERT = CERT;
process.env.MOCK_TLS_KEY = KEY;

await import("../server.js");
