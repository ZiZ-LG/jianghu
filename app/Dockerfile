# 江湖 前端生产镜像 — Vite 构建静态资源，Nginx 托管 + 反代 /api 到后端
# ---- 构建阶段 ----
FROM node:22-slim AS build
WORKDIR /app
# 国内构建加速：npm 用 npmmirror
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# 同源部署：VITE_API_URL 留空 → 前端走相对路径 /api（由本镜像内 Nginx 反代到后端）。
# 如需指向独立后端域名，在 build 时传 --build-arg VITE_API_URL=https://api.example.com
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
# 备案审核期开关：=1 时前端只渲染中性介绍页（无登录入口）。备案通过后置空/置0 重新构建即恢复完整应用。
ARG VITE_BEIAN_MODE=""
ENV VITE_BEIAN_MODE=$VITE_BEIAN_MODE
# 备案号（拿到后填入，页脚自动展示并链接到工信部备案系统）。
ARG VITE_ICP_BEIAN=""
ENV VITE_ICP_BEIAN=$VITE_ICP_BEIAN
# 公安备案号（可选）。
ARG VITE_POLICE_BEIAN=""
ENV VITE_POLICE_BEIAN=$VITE_POLICE_BEIAN
ARG VITE_POLICE_BEIAN_URL=""
ENV VITE_POLICE_BEIAN_URL=$VITE_POLICE_BEIAN_URL
RUN npm run build

# ---- 运行阶段 ----
FROM nginx:1.27-alpine AS runtime
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
