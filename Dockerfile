# Stage 1: Build the TypeScript project
FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Stage 2: Production image with only runtime dependencies
FROM node:22-alpine
RUN adduser -D -u 1000 appuser
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
USER appuser
EXPOSE 8080
ENTRYPOINT ["node", "dist/main.js"]
