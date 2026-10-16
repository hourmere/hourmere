# syntax=docker/dockerfile:1
# One image for cloud and self-hosting. Node runs the TypeScript sources directly
# (type stripping); only the web app is built.

FROM node:26-slim AS base
WORKDIR /app

# Manifests only, so dependency layers are cached until a package.json changes.
FROM base AS manifests
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/

FROM manifests AS build
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM manifests AS prod-deps
RUN npm ci --omit=dev --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/server apps/server
COPY packages/db packages/db
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/src/index.ts"]
