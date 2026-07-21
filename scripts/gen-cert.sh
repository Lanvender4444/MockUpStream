#!/usr/bin/env bash
# scripts/gen-cert.sh —— 生成本地自签证书(365 天)，SAN 覆盖 localhost + 127.0.0.1 + 本机所有局域网 IP，
# 这样局域网同事直接用 IP 访问也不会因为 SAN 不匹配被浏览器多报一层错。
# 用法：bash scripts/gen-cert.sh
# 需要：openssl（Git for Windows 自带；Mac/Linux 一般已装，没有就 apt/brew install openssl）
set -e

OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$OUT_DIR"

LAN_IPS=$(bun -e '
  const { networkInterfaces } = require("os");
  const nets = networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) for (const net of nets[name] || [])
    if (net.family === "IPv4" && !net.internal) ips.push(net.address);
  console.log(ips.join(","));
' 2>/dev/null || echo "")

SAN="subjectAltName=DNS:localhost,IP:127.0.0.1"
IFS=',' read -ra IPARR <<< "$LAN_IPS"
for ip in "${IPARR[@]}"; do
  [ -n "$ip" ] && SAN="$SAN,IP:$ip"
done

openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout "$OUT_DIR/key.pem" -out "$OUT_DIR/cert.pem" \
  -subj "//CN=mockupstream" \
  -addext "$SAN"

echo
echo "生成完成: $OUT_DIR/cert.pem , $OUT_DIR/key.pem  (已在 .gitignore/.dockerignore 里，不会被提交或打进镜像)"
echo "启动:"
echo "  Bash:       MOCK_TLS_CERT=$OUT_DIR/cert.pem MOCK_TLS_KEY=$OUT_DIR/key.pem bun run server.js"
echo "  PowerShell: \$env:MOCK_TLS_CERT=\"$OUT_DIR/cert.pem\"; \$env:MOCK_TLS_KEY=\"$OUT_DIR/key.pem\"; bun run server.js"
echo "自签证书浏览器首次访问会报不可信，点『继续访问』/『高级 -> 继续前往』即可；这不影响加密，只是没有公共 CA 背书。"
