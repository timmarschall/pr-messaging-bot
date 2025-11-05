###############################################
# Multi-stage Dockerfile for pr-messaging-bot #
# Builder installs dev deps (TypeScript, tests) and compiles to ./lib
# Runtime stage contains only production dependencies and built JS.
###############################################

# ---- Build stage ----
FROM node:22-slim AS build
WORKDIR /app

# Install all dependencies (including dev) for build & tests
COPY package.json package-lock.json ./
RUN npm ci

# Copy source (avoid copying node_modules from host via .dockerignore)
COPY . .

# Compile TypeScript to ./lib (start script uses lib/index.js)
RUN npm run build

# Optionally run tests during image build (disabled by default for speed)
# Uncomment if you want CI to fail on test errors inside the image.
RUN npm test

# ---- Production runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled output and any runtime config/assets
COPY --from=build /app/lib ./lib
COPY --from=build /app/config ./config
COPY --from=build /app/README.md ./
COPY --from=build /app/LICENSE ./

# Create non-root user for security
RUN useradd -r -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Start the Probot app (expects built JS in lib/)
CMD ["npm", "start"]