# 物业费后端镜像 —— 供微信云托管使用（构建上下文=仓库根目录，Dockerfile 名称填 "Dockerfile"）
# 内容与 deploy/Dockerfile.api 一致；云托管要求 Dockerfile 名称不含路径，故在根目录放一份。
FROM node:22-bookworm-slim AS build
WORKDIR /app

# 国内镜像加速（npm 包 + Prisma 引擎）
ENV COREPACK_NPM_REGISTRY=https://registry.npmmirror.com \
    PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma \
    npm_config_registry=https://registry.npmmirror.com

RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

RUN pnpm install --filter @pf/shared --filter @pf/api --frozen-lockfile
RUN pnpm --filter @pf/shared build
RUN cd apps/api && pnpm exec prisma generate && pnpm build

# ---- 运行时 ----
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production TZ=Asia/Shanghai
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app ./

WORKDIR /app/apps/api
EXPOSE 3000
# 启动前自动执行未应用的迁移（幂等）
#
# 中间那句 resolve 是一次性的恢复措施：20260804020000 在 2026-08-04 的部署里失败过，
# Prisma 会把它记成 failed，此后 migrate deploy 一律返回 P3009 并停下 ——
# 新容器起不来（老容器继续服务，业务不断，但**任何部署都发不出去**）。
# `resolve --rolled-back` 把它标回未应用，deploy 就会重放修好的那版 SQL。
# `|| true`：已经恢复之后再执行会报错，不能让它挡住启动。
# 恢复确认后应当删掉这一行 —— 它不该长期留在启动路径上。
CMD ["sh", "-c", "npx prisma migrate resolve --rolled-back 20260804020000_purge_test_communities || true; npx prisma migrate deploy && node dist/apps/api/src/main.js"]
