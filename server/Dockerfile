# ================================
# Stage 1: Build React client
# ================================

FROM node:20-alpine AS client-build

WORKDIR /app/client

# Public Vite variables
# These are baked into the frontend bundle during npm run build.
# NEVER put secrets here.

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID

RUN echo "VITE_GOOGLE_CLIENT_ID=$VITE_GOOGLE_CLIENT_ID"

RUN npm run build

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

# Copy React production build
COPY --from=client-build /app/client/dist ./client/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server/index.js"]