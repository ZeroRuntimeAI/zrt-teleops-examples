# ZeroRuntime Studio. Build from the repo root:
#
#   studio/scripts/vendor-wasm.sh          # temporary, see README "Temporary dependency"
#   docker build -t studio studio
#
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so pass them as build args.
# No secret is baked in: ZERORUNTIME_API_KEY and friends are read from the container env at run time.
# next/font/google is fetched during `next build`, so the build needs network access.

FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
# Temporary: repoint the out-of-tree teleops-wasm tarball at the vendored copy (same file, same integrity hash).
# Delete this line once @zeroruntime/teleops-wasm is on npm.
RUN sed -i -E 's|file:[^"]*/(zeroruntime-teleops-wasm-[^"/]*\.tgz)|file:./vendor/\1|' package.json package-lock.json
RUN npm ci

FROM node:20-slim AS build
WORKDIR /app
ARG NEXT_PUBLIC_STUDIO_OFFLINE
ARG NEXT_PUBLIC_STUDIO_TEST_HOOKS
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
# Standalone output carries its own minimal node_modules; static assets and public/ are not part of it.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
