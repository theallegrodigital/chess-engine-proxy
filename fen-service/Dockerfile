# FEN recognition service: tsoj/Chess_diagram_to_FEN behind FastAPI.
# The Node proxy forwards POST /fen here (FEN_SERVICE_URL) so the apps keep
# a single base URL.
#
# Dependencies come from the model repo's own uv lockfile (uv sync --frozen)
# — the exact versions the model was developed and tested against, and the
# exact setup that was verified locally. A freeform `pip install` of latest
# versions is what broke the first deployment.
#
# Image is large (~3GB: CPU torch + ~900MB model weights baked in) and wants
# ~1-1.5GB RAM at inference — the compose file caps it at 2GB.
FROM python:3.11-slim

# libcairo2: cairosvg (imported by the model code). libgl1 + libglib2.0-0:
# the lockfile pins regular opencv-python (not headless), whose `import cv2`
# needs libGL.so.1 on Linux. git/curl/unzip: fetch the model repo and weights
# at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl unzip libcairo2 libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

WORKDIR /app

# Pin the model repo to the commit this service was tested against.
ARG CDTF_COMMIT=3d751125357ebd47b91f6a8168e0b8d513fe7aae
RUN git clone https://github.com/tsoj/Chess_diagram_to_FEN.git \
    && cd Chess_diagram_to_FEN \
    && git checkout "$CDTF_COMMIT" \
    && rm -rf .git

WORKDIR /app/Chess_diagram_to_FEN

# Locked, CPU-only dependency set from the repo's uv.lock, plus the service's
# own web deps installed into the same venv.
RUN uv sync --extra cpu --frozen --no-dev
RUN uv pip install fastapi "uvicorn[standard]"

# Pretrained weights (~900MB) baked into the image; drop the training plots.
RUN curl -sL -o models.zip "https://github.com/tsoj/Chess_diagram_to_FEN/releases/download/1.0/models.zip" \
    && unzip -oq models.zip && rm models.zip && rm -f models/*/*.png

ENV CDTF_DIR=/app/Chess_diagram_to_FEN

# Warmup: pulls the torchvision backbone weights into the image and fails the
# build (with a full traceback in the build log) if a test inference doesn't
# produce a FEN.
COPY warmup.py app.py ./
RUN .venv/bin/python warmup.py

EXPOSE 8000

# Render/Coolify inject PORT; default to 8000 for local runs. Run the venv
# python directly — `uv run` would re-sync the env and drop fastapi/uvicorn.
CMD .venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
