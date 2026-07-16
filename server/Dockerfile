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

# 1) 内核包先行（server 的 file:../packages/pde-kernel 依赖，npm ci 建 symlink 时必须已存在）
COPY packages /packages

# 2) 依赖层（含 devDeps：运行期需要 tsx 跑 TS、prisma CLI 做 migrate deploy）
COPY server/package.json server/package-lock.json ./
RUN npm ci --install-links

# 3) 源码 + Prisma schema
COPY server .

# 4) PostgreSQL schema/migrations are generated and drift-checked in source control.
RUN node scripts/render-postgres-schema.mjs --check \
  && npx prisma generate --schema prisma/postgres/schema.prisma \
  && chmod +x docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# 容器内置 readiness 检查（数据库不可用时容器不进入 healthy）
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health/ready || exit 1

# 启动：先部署版本化迁移（带重试等待 DB 就绪），再起服务
ENTRYPOINT ["./docker-entrypoint.sh"]
