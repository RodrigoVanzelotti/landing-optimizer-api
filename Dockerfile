# syntax=docker/dockerfile:1
# --- dependency stage ---
FROM node:20-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci
RUN npx prisma generate

# --- local development/watch stage ---
FROM dependencies AS development
ENV NODE_ENV=development
ENV TSC_WATCHFILE=DynamicPriorityPolling
COPY . .
EXPOSE 3001
CMD ["npm", "run", "start:dev"]

# --- build stage ---
FROM development AS build
RUN npm run build

# --- runtime stage ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/prisma ./prisma

COPY --from=build /app/dist ./dist
COPY --from=build /app/clickhouse ./clickhouse
USER node
EXPOSE 3001
CMD ["node", "dist/main.js"]
