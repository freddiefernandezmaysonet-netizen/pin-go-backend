FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund
COPY prime-pilot/package.json prime-pilot/package-lock.json ./prime-pilot/
RUN npm ci --prefix prime-pilot --no-audit --no-fund
COPY src ./src
COPY prime-pilot ./prime-pilot
RUN npm run build --prefix prime-pilot
ENV NODE_ENV=production
CMD ["node", "--import", "tsx", "prime-pilot/server.ts"]
