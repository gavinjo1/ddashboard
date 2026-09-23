# ------------------------------------------------------------------ #
# Machine dashboard
#
# Node only — the frontend is plain ES modules served straight from
# public/, so there is nothing to bundle and no build stage for it.
# pg and xlsx are pure JavaScript, so alpine needs no toolchain.
# ------------------------------------------------------------------ #

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci installs exactly the lockfile, and fails if the two disagree.
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# --init gives PID 1 a real init, so SIGTERM reaches node and the pool's
# SIGINT handler can close it. Without it the container waits out the
# 10-second kill timeout on every stop.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Nothing is written to disk at runtime — uploads are parsed in memory — so
# the container can run read-only and unprivileged.
USER node

EXPOSE 3000

# /api/auth/me is reachable without a session and still touches the database,
# so it fails when Postgres is gone. Node 22 has fetch built in; alpine has
# no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/me').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server/index.js"]
