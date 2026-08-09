# ================================
# Stage 1: Build React client
# ================================
FROM node:20-alpine AS client-build

WORKDIR /app/client

# NEW: optional build-time args for PUBLIC client vars only (Vite
# bakes these into the bundle — never put secrets here). Add more
# ARG/ENV pairs the same way if client/.env has other VITE_* keys.
# Leave unset if you don't need any (e.g. API_BASE now defaults to
# a relative same-origin path in production).
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

COPY client/package*.json ./
RUN npm ci

COPY client/ .
RUN npm run build


# ================================
# Stage 2: Run Node server
# ================================
FROM node:20-alpine

WORKDIR /app

COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/

# Copy React build output
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server/index.js"]