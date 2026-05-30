# 江湖 后端生产镜像 — Fastify + Prisma + PostgreSQL
# 用 debian-slim（Prisma 在 alpine/musl 上需额外处理，slim 开箱即用）
FROM node:22-slim AS base
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates wget \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# 国内构建加速：npm 用 npmmirror；Prisma 引擎走 npmmirror 镜像（否则从 binaries.prisma.sh 拉取易超时）
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma

# 1) 依赖层（含 devDeps：运行期需要 tsx 跑 TS、prisma CLI 做 db push）
COPY package.json package-lock.json ./
RUN npm ci

# 2) 源码 + Prisma schema
COPY . .

# 3) 把 Prisma provider 从 sqlite 切到 postgresql，再生成客户端；并赋予入口脚本可执行权限。
#    （仓库里 schema 默认保持 sqlite 供本地零配置开发；镜像内统一用 PG。）
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma \
  && npx prisma generate \
  && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# 容器内置健康检查（命中后端 /api/health）
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health || exit 1

# 启动：先把表结构同步到 Postgres（带重试等待 DB 就绪），再起服务
ENTRYPOINT ["./docker-entrypoint.sh"]
