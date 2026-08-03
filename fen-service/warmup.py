"""Build-time warmup: forces the torchvision backbone downloads into the
image and fails the Docker build if a test inference doesn't return a FEN —
so a broken model setup is caught at build time, not by the first user."""
import os
import sys

sys.path.insert(0, os.environ.get("CDTF_DIR", "/app/Chess_diagram_to_FEN"))

from PIL import Image

from chess_diagram_to_fen import get_fen

TEST_IMAGE = os.path.join(
    os.environ.get("CDTF_DIR", "/app/Chess_diagram_to_FEN"),
    "resources/test_images/real_use_cases_chess",
)

name = sorted(os.listdir(TEST_IMAGE))[2]
img = Image.open(os.path.join(TEST_IMAGE, name))
result = get_fen(img, game="chess", auto_rotate_image=True, auto_rotate_board=True)
assert result is not None and result.fen, f"warmup inference failed on {name}"
print(f"warmup ok: {name} -> {result.fen}")
