FROM node:24.12.0-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Server listens on this port (override at runtime with env)
ENV PORT=3001
EXPOSE 3001

# Do not bake .env into the image — pass at runtime: DATABASE_URL, AWS_*, JWT_*, EASEBUZZ_*, SMTP_*, FRONTEND_URL, PORT
CMD ["node", "app.js"]
