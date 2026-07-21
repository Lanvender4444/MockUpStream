# mockupstream —— 独立可运行镜像（无需宿主机装 bun，也无需 volume 挂载）
# 用法：docker run --rm -p 8788:8788 ghcr.io/<owner>/mockupstream
# 数据持久化：mock.db 落在容器内 /app，如需跨重建保留，自行挂载 -v mockdb:/app/mock.db

FROM oven/bun:1

WORKDIR /app
COPY . .

ENV MOCK_PORT=8788
EXPOSE 8788

CMD ["bun", "run", "server.js"]
