# FEN recognition service: tsoj/Chess_diagram_to_FEN behind FastAPI.
# The Node proxy forwards POST /fen here (FEN_SERVICE_URL) so the apps keep
# a single base URL.
#
# Image is large (~3GB: CPU torch + ~900MB model weights baked in) and wants
# ~1GB+ RAM at inference — do not deploy on a 512MB instance.
FROM python:3.11-slim

# libcairo2: cairosvg (imported by the model code). git/curl/unzip: fetch the
# model repo and weights at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl unzip libcairo2 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin the model repo to the commit this service was tested against.
ARG CDTF_COMMIT=3d751125357ebd47b91f6a8168e0b8d513fe7aae
RUN git clone https://github.com/tsoj/Chess_diagram_to_FEN.git \
    && cd Chess_diagram_to_FEN \
    && git checkout "$CDTF_COMMIT" \
    && rm -rf .git

# CPU-only torch first (much smaller than the default CUDA build), then the
# model repo's runtime deps (headless opencv — no GUI libs in the image),
# then the service's own deps.
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir \
    Pillow numpy matplotlib scikit-image tqdm pyffish cairosvg pyfastnoiselite \
    "opencv-python-headless>=4.13" \
    fastapi "uvicorn[standard]"

# Pretrained weights (~900MB) baked into the image; drop the training plots.
RUN cd Chess_diagram_to_FEN \
    && curl -sL -o models.zip "https://github.com/tsoj/Chess_diagram_to_FEN/releases/download/1.0/models.zip" \
    && unzip -oq models.zip && rm models.zip && rm -f models/*/*.png

ENV CDTF_DIR=/app/Chess_diagram_to_FEN

# Warmup: pulls the torchvision backbone weights into the image and fails the
# build if a test inference doesn't produce a FEN.
COPY warmup.py app.py ./
RUN python warmup.py

EXPOSE 8000

# Render injects PORT; default to 8000 for local runs.
CMD uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000}
