#!/usr/bin/env bash
# scripts/gen-cert.sh —— 生成本地证书，覆盖 localhost + 127.0.0.1 + 本机所有局域网 IP。
# 优先用 mkcert（装了的话）：它会往系统信任库塞一个本地根证书，生成的证书浏览器直接认，没有警告。
# 没装 mkcert 就退回 openssl 自签证书 —— 能用，但浏览器首次访问会有一次性"不安全"警告。
# 用法：bash scripts/gen-cert.sh
# mkcert 装法：winget install FiloSottile.mkcert  (或 choco install mkcert / brew install mkcert)
set -e

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$OUT_DIR"

LAN_IPS=$(bun -e '
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) for (const net of nets[name] || [])
    if (net.family === "IPv4" && !net.internal) ips.push(net.address);
  console.log(ips.join(" "));
' 2>/dev/null || echo "")

if command -v mkcert >/dev/null 2>&1; then
  echo "检测到 mkcert，走本地信任 CA 方案(浏览器不会报警告)..."
  mkcert -install
  mkcert -cert-file "$OUT_DIR/cert.pem" -key-file "$OUT_DIR/key.pem" localhost 127.0.0.1 ::1 $LAN_IPS
else
  echo "未装 mkcert，走 openssl 自签证书(浏览器会有一次性不安全警告)。装 mkcert 可以去掉警告：winget install FiloSottile.mkcert"
  SAN="subjectAltName=DNS:localhost,IP:127.0.0.1"
  for ip in $LAN_IPS; do
    SAN="$SAN,IP:$ip"
  done
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$OUT_DIR/key.pem" -out "$OUT_DIR/cert.pem" \
    -subj "//CN=mockupstream" \
    -addext "$SAN"
fi

echo
echo "生成完成: $OUT_DIR/cert.pem , $OUT_DIR/key.pem  (已在 .gitignore/.dockerignore 里，不会被提交或打进镜像)"
echo "启动:"
echo "  Bash:       MOCK_TLS_CERT=$OUT_DIR/cert.pem MOCK_TLS_KEY=$OUT_DIR/key.pem bun run server.js"
echo "  PowerShell: \$env:MOCK_TLS_CERT=\"$OUT_DIR/cert.pem\"; \$env:MOCK_TLS_KEY=\"$OUT_DIR/key.pem\"; bun run server.js"
