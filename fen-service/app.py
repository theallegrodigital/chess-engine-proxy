"""FEN recognition service: wraps tsoj/Chess_diagram_to_FEN behind a tiny
HTTP API for the Chess Engine apps.

POST /fen  {"image": "<base64 JPEG/PNG>"}
  -> 200 {"fen": "<full FEN>", "boardIsFlipped": true|false}
  -> 422 {"error": "NO_BOARD" | "BAD_IMAGE" | "IMAGE_TOO_LARGE"}
GET /healthz -> 200 "ok"

The model auto-detects the board, its rotation, and whether the diagram is
seen from black's side; the returned FEN is always in standard (white)
orientation and boardIsFlipped tells the app which side the photo was
taken from.
"""
import base64
import binascii
import io
import os
import sys
import threading

from fastapi import FastAPI
from fastapi.responses import JSONResponse, PlainTextResponse
from PIL import Image
from pydantic import BaseModel

# The model repo is not an installed package; it imports via `src.*` relative
# to its own root, so that root must be on sys.path and be the cwd-agnostic
# base for its model file lookups (it resolves those from __file__, so path
# insertion is enough).
sys.path.insert(0, os.environ.get("CDTF_DIR", "/app/Chess_diagram_to_FEN"))

from chess_diagram_to_fen import get_fen  # noqa: E402

app = FastAPI()

# One inference at a time: torch on a small CPU instance gains nothing from
# concurrent requests and the extra resident memory can OOM the dyno.
_inference_lock = threading.Lock()

MAX_IMAGE_BYTES = 12 * 1024 * 1024


class FenRequest(BaseModel):
    image: str


def _expand(placement: str) -> list[str] | None:
    ranks = placement.split("/")
    if len(ranks) != 8:
        return None
    rows = []
    for rank in ranks:
        row = ""
        for ch in rank:
            row += "1" * int(ch) if ch.isdigit() else ch
        if len(row) != 8:
            return None
        rows.append(row)
    return rows


def _rotate180(rows: list[str]) -> str:
    """180-degree rotation of an expanded board, back to collapsed placement."""
    rotated = [row[::-1] for row in reversed(rows)]
    ranks = []
    for row in rotated:
        field = ""
        run = 0
        for ch in row:
            if ch == "1":
                run += 1
            else:
                if run:
                    field += str(run)
                    run = 0
                field += ch
        if run:
            field += str(run)
        ranks.append(field)
    return "/".join(ranks)


def _plausible(rows: list[str]) -> bool:
    flat = "".join(rows)
    if flat.count("K") != 1 or flat.count("k") != 1:
        return False
    if flat.count("P") > 8 or flat.count("p") > 8:
        return False
    # Pawns can never sit on a back rank; their presence there means the
    # recognition glitched and the app should fall back rather than import.
    return not any(ch in "Pp" for ch in rows[0] + rows[7])


def full_fen(placement: str, rows: list[str]) -> str:
    """Placement -> full FEN. Side to move defaults to white (a still image
    rarely tells); castling rights only where king+rook still sit at home."""
    def piece_at(rank: int, file: int) -> str:
        return rows[8 - rank][file]

    castling = ""
    if piece_at(1, 4) == "K":
        if piece_at(1, 7) == "R":
            castling += "K"
        if piece_at(1, 0) == "R":
            castling += "Q"
    if piece_at(8, 4) == "k":
        if piece_at(8, 7) == "r":
            castling += "k"
        if piece_at(8, 0) == "r":
            castling += "q"
    return f"{placement} w {castling or '-'} - 0 1"


@app.get("/healthz")
def healthz():
    return PlainTextResponse("ok")


@app.post("/fen")
def recognize(req: FenRequest):
    try:
        raw = base64.b64decode(req.image, validate=True)
    except (binascii.Error, ValueError):
        return JSONResponse({"error": "BAD_IMAGE"}, status_code=422)
    if len(raw) > MAX_IMAGE_BYTES:
        return JSONResponse({"error": "IMAGE_TOO_LARGE"}, status_code=422)
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:
        return JSONResponse({"error": "BAD_IMAGE"}, status_code=422)

    with _inference_lock:
        # auto_rotate_board=False: return the position exactly as pictured.
        # The model's flipped-or-not guess is statistical (weak on sparse
        # endgames), while the app can read the printed coordinate labels
        # with OCR — so the final orientation decision belongs to the app.
        result = get_fen(img, game="chess", auto_rotate_image=True, auto_rotate_board=False)

    if result is None or not result.fen:
        return JSONResponse({"error": "NO_BOARD"}, status_code=422)
    # result.fen may be a full FEN ("<placement> w - - 0 1"); keep only the
    # placement and rebuild the rest deterministically.
    placement_as_seen = result.fen.split()[0]
    rows = _expand(placement_as_seen)
    if rows is None or not _plausible(rows):
        return JSONResponse({"error": "NO_BOARD"}, status_code=422)

    flipped_guess = bool(result.board_is_flipped)
    best_placement = _rotate180(rows) if flipped_guess else placement_as_seen
    best_rows = _expand(best_placement)

    return {
        # Server's best-guess orientation applied — for debugging and simple
        # clients. The iOS app rebuilds from placementAsSeen + its own OCR.
        "fen": full_fen(best_placement, best_rows),
        "placementAsSeen": placement_as_seen,
        "boardIsFlipped": flipped_guess,
    }
