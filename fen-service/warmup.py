"""Build-time warmup: forces the torchvision backbone downloads into the
image and fails the Docker build if a test inference doesn't return a FEN —
so a broken model setup is caught at build time, not by the first user.
Prints versions and a full traceback so build-log failures are diagnosable."""
import os
import sys
import traceback

CDTF_DIR = os.environ.get("CDTF_DIR", "/app/Chess_diagram_to_FEN")
sys.path.insert(0, CDTF_DIR)

try:
    import numpy
    import PIL
    import torch
    import torchvision

    print(
        f"warmup env: python {sys.version.split()[0]}, torch {torch.__version__}, "
        f"torchvision {torchvision.__version__}, numpy {numpy.__version__}, "
        f"pillow {PIL.__version__}",
        flush=True,
    )

    from PIL import Image

    from chess_diagram_to_fen import get_fen

    test_dir = os.path.join(CDTF_DIR, "resources/test_images/real_use_cases_chess")
    name = sorted(os.listdir(test_dir))[2]
    print(f"warmup image: {name}", flush=True)

    result = get_fen(
        Image.open(os.path.join(test_dir, name)),
        game="chess",
        auto_rotate_image=True,
        auto_rotate_board=True,
    )
    assert result is not None and result.fen, "warmup inference produced no FEN"
    print(f"warmup ok: {result.fen}", flush=True)
except Exception:
    traceback.print_exc()
    sys.exit(1)
