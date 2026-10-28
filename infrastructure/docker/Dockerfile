# Multi-target image for the API and the worker.
#   docker build -f infrastructure/docker/Dockerfile --target api -t uap-api .
#   docker build -f infrastructure/docker/Dockerfile --target worker -t uap-worker .
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Self-contained production installs (only each app's own runtime dependencies).
RUN pnpm deploy --filter @uap/api --prod --legacy /out/api \
 && pnpm deploy --filter @uap/worker --prod --legacy /out/worker \
 && cp -r apps/api/dist /out/api/dist \
 && cp -r apps/worker/dist /out/worker/dist

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=build --chown=node:node /out/api /app
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/health/live || exit 1
CMD ["node", "dist/index.js"]

FROM runtime AS worker
COPY --from=build --chown=node:node /out/worker /app
CMD ["node", "dist/index.js"]
