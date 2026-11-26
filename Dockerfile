# Always-On Production Image cho Cafe POS Backend (Node 20 Alpine — Không chứa devDependencies/node_modules rác)
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    LOG_FORMAT=json

# Cài dependencies production thuần túy từ lockfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy mã nguồn sạch (đã lọc qua .dockerignore)
COPY server.js db.js config.js middleware.js password.js ./
COPY modules ./modules
COPY src ./src
COPY db ./db

RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]
