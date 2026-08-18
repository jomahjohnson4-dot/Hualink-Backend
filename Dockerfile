# ----------------------------------------------------
# Base Stage: Install Dependencies & Generate Prisma Client
# ----------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install system dependencies required for Prisma
RUN apk add --no-cache openssl

# Configure npm network timeouts and retries
ENV NPM_CONFIG_FETCH_RETRIES=5
ENV NPM_CONFIG_FETCH_RETRY_FACTOR=2
ENV NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000
ENV NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

# Copy package manifests
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies with retry resilience
RUN npm install

# Generate Prisma Client
RUN npx prisma generate

# Copy source code
COPY . .

# ----------------------------------------------------
# Production Stage: Lightweight Runtime Image
# ----------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production

# Install PM2 globally for process management
RUN npm install -g pm2

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm install --only=production

# Copy Prisma schema and generated binaries from builder
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Copy source code and config files
COPY --from=builder /app/server.js ./server.js
COPY --from=builder /app/src ./src
COPY --from=builder /app/ecosystem.config.js ./ecosystem.config.js

# Create log directory
RUN mkdir -p logs

EXPOSE 5000

# Start application using PM2 runtime
CMD ["pm2-runtime", "start", "ecosystem.config.js"]