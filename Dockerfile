FROM node:20-slim

# Install Stockfish from Debian's apt repo, then symlink it onto PATH. Debian installs the
# binary at /usr/games/stockfish, which isn't on the default PATH inside node:20-slim — so
# Node's `spawn('stockfish')` would otherwise fail with ENOENT at runtime. The symlink to
# /usr/local/bin/stockfish makes the binary reachable without depending on PATH config.
RUN apt-get update \
    && apt-get install -y --no-install-recommends stockfish ca-certificates \
    && ln -sf /usr/games/stockfish /usr/local/bin/stockfish \
    && test -x /usr/games/stockfish || (echo "Stockfish install failed" && exit 1) \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Node deps with a deterministic, no-dev install.
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the app source.
COPY . .

# Render injects PORT; we read it inside server.js. EXPOSE is informational on Render.
EXPOSE 3000

CMD ["node", "server.js"]
