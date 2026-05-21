FROM node:20-slim

# Install Stockfish from Debian's apt repo. The build is current enough (Stockfish 15+) for
# our depth-12 to depth-18 use case — we don't need the latest NNUE optimization tricks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends stockfish ca-certificates \
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
