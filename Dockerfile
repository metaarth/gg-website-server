FROM node:24.12.0-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

RUN chown -R node:node /app
USER node

# Server listens on this port (override at runtime with env)
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Do not bake .env into the image — pass at runtime (Compose env_file, K8s secrets, etc.)
CMD ["node", "app.js"]
