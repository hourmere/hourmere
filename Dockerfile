# syntax=docker/dockerfile:1
# One image for cloud and self-hosting. Node runs the TypeScript sources directly
# (type stripping); only the web app is built.

FROM node:26-slim AS base
WORKDIR /app

# Copies the whole workspace so new apps/packages need no Dockerfile changes.
FROM base AS build
COPY . .
RUN npm ci --ignore-scripts \
 && npm run build --workspace @hourmere/web \
 && npm prune --omit=dev --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/src/index.ts"]
