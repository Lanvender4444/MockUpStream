#!/usr/bin/env bash
# scripts/deploy.sh —— 本地 docker build 打包镜像，scp 上传到云服务器，远端 load 并重启容器。
# 不依赖 GHCR/公网镜像仓库，服务器能连本机 ssh 就行。
#
# 用法：DEPLOY_HOST=user@1.2.3.4 bash scripts/deploy.sh
#
# 环境变量：
#   DEPLOY_HOST     必填，形如 user@1.2.3.4（或 ~/.ssh/config 里配好的别名）
#   DEPLOY_PORT     ssh 端口，默认 22
#   DEPLOY_KEY      ssh 私钥路径，不填就走 ssh-agent/默认身份
#   DEPLOY_DIR      远端存放镜像包的目录（相对远端登录用户 home），默认 mockupstream
#   IMAGE_NAME      镜像名，默认 mockupstream
#   IMAGE_TAG       镜像 tag，默认 latest
#   CONTAINER_NAME  远端容器名，默认 mock-upstream
#   DB_VOLUME       远端 named volume（挂到容器内 /app/mock.db，重建容器不丢数据），默认 <CONTAINER_NAME>-db
#   PORTS           端口映射，空格分隔，默认 "8788:8788 8789:8789 8790:8790 8791:8791"
#
# 例：DEPLOY_HOST=root@1.2.3.4 DEPLOY_PORT=2222 DEPLOY_KEY=~/.ssh/id_ed25519 bash scripts/deploy.sh
set -e

: "${DEPLOY_HOST:?用法: DEPLOY_HOST=user@host bash scripts/deploy.sh}"
DEPLOY_PORT="${DEPLOY_PORT:-22}"
DEPLOY_KEY="${DEPLOY_KEY:-}"
DEPLOY_DIR="${DEPLOY_DIR:-mockupstream}"
IMAGE_NAME="${IMAGE_NAME:-mockupstream}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
CONTAINER_NAME="${CONTAINER_NAME:-mock-upstream}"
DB_VOLUME="${DB_VOLUME:-${CONTAINER_NAME}-db}"
PORTS="${PORTS:-8788:8788 8789:8789 8790:8790 8791:8791}"

SSH_OPTS=(-p "$DEPLOY_PORT")
[ -n "$DEPLOY_KEY" ] && SSH_OPTS+=(-i "$DEPLOY_KEY")

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAR_NAME="${IMAGE_NAME}-${IMAGE_TAG}.tar"
LOCAL_TAR="$(mktemp -t "${IMAGE_NAME}.XXXXXX")-$TAR_NAME"
trap 'rm -f "$LOCAL_TAR"' EXIT

echo "==> [1/4] 本地构建镜像 $IMAGE_NAME:$IMAGE_TAG"
docker build -t "$IMAGE_NAME:$IMAGE_TAG" "$ROOT_DIR"

echo "==> [2/4] 导出镜像为 $LOCAL_TAR"
docker save -o "$LOCAL_TAR" "$IMAGE_NAME:$IMAGE_TAG"

echo "==> [3/4] 上传到 $DEPLOY_HOST:$DEPLOY_DIR/$TAR_NAME"
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "mkdir -p '$DEPLOY_DIR'"
scp "${SSH_OPTS[@]}" "$LOCAL_TAR" "$DEPLOY_HOST:$DEPLOY_DIR/$TAR_NAME"

echo "==> [4/4] 远端 load 镜像并重启容器 $CONTAINER_NAME"
PORT_ARGS=""
for p in $PORTS; do PORT_ARGS="$PORT_ARGS -p $p"; done

ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" bash -s <<EOF
set -e
cd "$DEPLOY_DIR"
docker load -i "$TAR_NAME"
rm -f "$TAR_NAME"
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker volume create "$DB_VOLUME" >/dev/null
docker run -d --name "$CONTAINER_NAME" --restart unless-stopped \
  $PORT_ARGS \
  -v "$DB_VOLUME:/app/mock.db" \
  "$IMAGE_NAME:$IMAGE_TAG"
echo "容器已启动: \$(docker ps --filter name="$CONTAINER_NAME" --format '{{.Names}} {{.Status}} {{.Ports}}')"
EOF

echo
echo "部署完成。控制台: http://<服务器IP>:8788/"
echo "记得在云服务器安全组/防火墙放行用到的端口（默认 8788、8789-8791）。"
