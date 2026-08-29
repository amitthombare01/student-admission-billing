FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js ./
COPY src ./src
COPY migrations ./migrations
COPY _internal/index.html _internal/admin.html _internal/script.js _internal/admin.js _internal/style.css ./_internal/
COPY _internal/manifest.json _internal/service-worker.js _internal/school-icon.png ./_internal/

RUN chown -R node:node /app

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
