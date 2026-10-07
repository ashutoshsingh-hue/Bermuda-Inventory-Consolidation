# Bermuda Sort Station — for IT hosting later (PLAN.md §12 O2). The laptop runs `npm start`
# directly; this exists so IT can containerize the same code unchanged.
FROM node:20-slim

# build tools as a fallback in case a prebuilt better-sqlite3 binary isn't available
# for the target platform; npm skips the compile step when a prebuilt binary is found.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/bermuda.db
VOLUME ["/data", "/app/backups"]
EXPOSE 8080

CMD ["node", "src/server.js"]
