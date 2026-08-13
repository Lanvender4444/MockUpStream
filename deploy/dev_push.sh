#!/bin/bash
set -e

# ============================================
# 本地构建并推送镜像脚本 (mock-upstream)
#
# 用法:
#   docker login sudocode-cn-hongkong.cr.volces.com
#
#   bash deploy/dev_push.sh           # 构建并推送
#   bash deploy/dev_push.sh build     # 仅构建
#   bash deploy/dev_push.sh push      # 仅推送
#   bash deploy/dev_push.sh login     # 登录仓库
#
# 推送目标:
#   sudocode-cn-hongkong.cr.volces.com/dream-taiqi/mockupstream:latest
#
# 服务器首次部署:
#   1. 将生产 docker-compose.yml 放到 ${COMPOSE_DIR}
#   2. sudo docker login sudocode-cn-hongkong.cr.volces.com
#   3. cd ${COMPOSE_DIR}
#      sudo docker-compose pull ${SERVICE_NAME}
#      sudo docker-compose up -d ${SERVICE_NAME}
#
# 后续更新:
#   cd ${COMPOSE_DIR}
#   sudo docker-compose pull ${SERVICE_NAME} && \
#   sudo docker-compose up -d ${SERVICE_NAME}
# ============================================

REGISTRY="sudocode-cn-hongkong.cr.volces.com"
NAMESPACE="dream-taiqi"

# 火山引擎镜像仓库中的镜像名称
IMAGE_NAME="mockupstream"

# docker-compose.yml 中 services: 下的服务名称
SERVICE_NAME="mock-upstream"

# 服务器 docker-compose.yml 所在目录
COMPOSE_DIR="/www/dk_project/dk_app/mock-upstream"

TAG="latest"
VERSION_TAG="$(date +%Y%m%d%H%M%S)"

FULL_IMAGE="${REGISTRY}/${NAMESPACE}/${IMAGE_NAME}:${TAG}"
VERSION_IMAGE="${REGISTRY}/${NAMESPACE}/${IMAGE_NAME}:${VERSION_TAG}"

# deploy/dev_push.sh 在项目 deploy/ 目录中
# 所以项目根目录是脚本上一级
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

build_image() {
    log_info "=== 构建 mock-upstream 镜像 ==="

    cd "$PROJECT_DIR"

    log_info "项目目录: $PROJECT_DIR"
    log_info "目标镜像: $FULL_IMAGE"
    log_info "版本镜像: $VERSION_IMAGE"
    log_info "目标架构: linux/amd64"

    docker build \
        --platform linux/amd64 \
        -t "${FULL_IMAGE}" \
        -t "${VERSION_IMAGE}" \
        .

    log_info "镜像构建完成"
}

print_server_commands() {
    echo ""

    log_info "服务器更新命令:"
    echo "  cd ${COMPOSE_DIR}"
    echo "  sudo docker-compose pull ${SERVICE_NAME} && sudo docker-compose up -d ${SERVICE_NAME}"

    echo ""

    log_info "查看运行状态:"
    echo "  cd ${COMPOSE_DIR}"
    echo "  sudo docker-compose ps ${SERVICE_NAME}"

    echo ""

    log_info "查看日志:"
    echo "  cd ${COMPOSE_DIR}"
    echo "  sudo docker-compose logs -f --tail=200 ${SERVICE_NAME}"

    echo ""

    log_warn "本次版本标签:"
    log_warn "  ${VERSION_TAG}"

    log_warn "本次完整版本镜像:"
    log_warn "  ${VERSION_IMAGE}"

    echo ""

    log_warn "如需回滚:"
    echo "  将 docker-compose.yml 中:"
    echo "    image: ${FULL_IMAGE}"
    echo ""
    echo "  改为:"
    echo "    image: ${VERSION_IMAGE}"
    echo ""
    echo "  然后执行:"
    echo "    sudo docker-compose up -d ${SERVICE_NAME}"
}

push_image() {
    log_info "=== 推送 mock-upstream 镜像 ==="

    docker push "${FULL_IMAGE}"
    docker push "${VERSION_IMAGE}"

    log_info "镜像推送完成:"
    log_info "  latest:"
    log_info "    ${FULL_IMAGE}"

    log_info "  version:"
    log_info "    ${VERSION_IMAGE}"

    print_server_commands
}

show_help() {
    echo "用法:"
    echo "  bash deploy/dev_push.sh [命令]"
    echo ""

    echo "命令:"
    echo "  (无参数)    构建并推送镜像"
    echo "  build       仅构建镜像"
    echo "  push        仅推送镜像"
    echo "  login       登录镜像仓库"
    echo "  help        显示帮助"
    echo ""

    echo "当前配置:"
    echo "  项目目录:"
    echo "    ${PROJECT_DIR}"
    echo ""

    echo "  latest 镜像:"
    echo "    ${FULL_IMAGE}"
    echo ""

    echo "  version 镜像:"
    echo "    ${VERSION_IMAGE}"
    echo ""

    echo "  服务器目录:"
    echo "    ${COMPOSE_DIR}"
    echo ""

    echo "  Compose 服务:"
    echo "    ${SERVICE_NAME}"
}

main() {
    case "${1:-}" in
        build)
            build_image
            ;;
        push)
            push_image
            ;;
        login)
            docker login "${REGISTRY}"
            ;;
        help|--help|-h)
            show_help
            ;;
        *)
            build_image
            push_image
            ;;
    esac
}

main "$@"