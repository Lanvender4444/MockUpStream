# mockupstream —— 独立可运行镜像（无需宿主机装 bun，也无需 volume 挂载）
# 用法：docker run --rm -p 8788:8788 -p 8789-8791:8789-8791 ghcr.io/<owner>/mockupstream
# 数据持久化：mock.db 落在容器内 /app，如需跨重建保留，自行挂载 -v mockdb:/app/mock.db
# 8789-8791 是种子渠道(Channels)默认端口；自己在控制台建了新渠道/改了端口，起容器时要一并 -p 映射出去。

FROM oven/bun:1

WORKDIR /app
COPY . .

ENV MOCK_PORT=8788
EXPOSE 8788 8789-8791

CMD ["bun", "run", "server.js"]
