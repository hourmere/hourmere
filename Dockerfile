# syntax=docker/dockerfile:1
# One image for cloud and self-hosting. Node runs the TypeScript sources directly
# (type stripping); only the web app is built.

FROM node:26-slim AS base
WORKDIR /app

# Copies the whole workspace so new apps/packages need no Dockerfile changes.
# Optional packages are pruned too: better-auth declares optional peers that are also
# dev tools (react, react-dom, vitest, which brings in vite), and npm keeps them on
# --omit=dev alone. So everything the server imports at run time must be a regular
# dependency of some workspace, as pg is, although better-auth lists it as optional.
FROM base AS build
COPY . .
# Sharp's platform binaries and libvips are optional npm dependencies, but required
# by logo uploads. Preserve only its @img packages while pruning optional dev peers.
RUN npm ci --ignore-scripts \
 && npm run build --workspace @hourmere/web \
 && cp -a node_modules/@img /tmp/hourmere-sharp-img \
 && npm prune --omit=dev --omit=optional --ignore-scripts \
 && mkdir -p node_modules/@img \
 && cp -a /tmp/hourmere-sharp-img/. node_modules/@img/ \
 && node --input-type=module -e "import sharp from 'sharp'; await sharp({create:{width:1,height:1,channels:3,background:'white'}}).png().toBuffer()"

FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/apps/web/dist
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/scripts/redispatch-calendar-writeback.ts ./scripts/redispatch-calendar-writeback.ts
USER node
EXPOSE 3000
# HOURMERE_ROLE (all, web or worker; default all) picks what a container runs. Every role
# listens on PORT and answers /api/health (a worker answers nothing else), so this one check
# fits all of them. On SIGTERM running jobs get up to 20 s: allow at least 35 s to stop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/server/src/index.ts"]
