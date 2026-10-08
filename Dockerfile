# syntax=docker/dockerfile:1
#
# AusbildungsWeg — production image for Azure Container Apps (or any OCI
# runner). Multi-stage: dependencies → build → minimal runtime.
#
# Base: node:22-bookworm-slim (Debian 12, glibc). Alpine is deliberately
# NOT used: @napi-rs/canvas ships prebuilt .node binaries for glibc
# (musl builds would be required on Alpine and break the PDF pipeline).
#
# SECURITY:
#   - No secrets in this file. Only the two NEXT_PUBLIC_* values are passed
#     as build args — they are public by design (inlined into the client
#     bundle; NEXT_PUBLIC_SUPABASE_URL is additionally baked into the CSP
#     by next.config.ts). All private keys (Supabase service role, OAuth,
#     AI, LiveKit, worker secret, token encryption key) are injected at
#     RUNTIME by the container platform, never baked in.
#   - The runtime stage runs as a dedicated non-root user.
#   - .dockerignore excludes .env*, .git, tests' heavy assets, etc.

# ── Stage 1: dependencies ────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ── Stage 2: production build ────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Public build-time configuration ONLY (see SECURITY note above).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

# ── Stage 3: minimal runtime ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app

# Dedicated non-root user (uid/gid 1001, "nextjs").
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --home-dir /app nextjs

# Standalone server (traced node_modules included) + client assets + public.
# @napi-rs/canvas native binaries come along inside standalone/node_modules
# via the build's file tracing (serverExternalPackages).
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./
COPY --from=build --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Probe split (mirrors the Azure Container Apps configuration):
#   - LIVENESS (this HEALTHCHECK): dependency-free TCP connect to the app
#     port — "is the process listening?". A DB outage must NOT kill a
#     healthy process, so liveness never touches the application layer.
#   - READINESS: GET /api/health — 200 when app + database are healthy,
#     503 degraded. Configure this as the Azure readiness probe so
#     traffic is drained (not the container restarted) during DB issues.
# Azure Container Apps uses its own probes (liveness: tcp:3000,
# readiness: httpGet /api/health); this HEALTHCHECK serves docker/compose
# and other runtimes with the same liveness semantics.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const s=require('net').connect(Number(process.env.PORT||3000),'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),4000)"

CMD ["node", "server.js"]
