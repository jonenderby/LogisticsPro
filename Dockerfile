# Logistics Pro: API server plus the website, in one image.
FROM node:22-bookworm-slim
WORKDIR /app
COPY . .
ENV CI=1 EXPO_OFFLINE=1
RUN npm ci && npm run build:web
ENV NODE_ENV=production \
    PORT=8080 \
    LP_WEB_DIR=/app/dist/web \
    LP_AS2_DIR=/data/as2 \
    LP_EDI_OUTBOX=/data/edi-outbox
VOLUME ["/data"]
EXPOSE 8080
CMD ["npx", "tsx", "apps/api/src/server.ts"]
