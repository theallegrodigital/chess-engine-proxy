# chess-engine-proxy

A tiny HTTP wrapper around Stockfish. Request/response shape matches
[`chess-api.com/v1`](https://chess-api.com), so any client speaking that API (including the
[Chess Engine for Stockfish](https://github.com/) Android app) can swap endpoints by changing one
URL constant.

## Why

`chess-api.com` is third-party and occasionally goes down. This service is a drop-in replacement
you control: same wire format, Stockfish under the hood, free to host.

## Endpoints

### `GET /`
Status probe. Returns `{"status":"ok","engine":"stockfish","endpoint":"POST /v1"}`.

### `GET /healthz`
Returns `200 OK` with body `ok`. Used by uptime monitors (UptimeRobot, BetterStack, etc.) to
keep the Render free dyno warm — ping it every 5 minutes and you eliminate cold-starts.

### `POST /v1`
Analyze a position.

**Request body**:
```json
{
  "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  "depth": 12,
  "maxThinkingTime": 1000,
  "variants": 1
}
```

| Field | Type | Default | Range |
|---|---|---|---|
| `fen` | string | _(required)_ | any valid FEN; parsed via chess.js |
| `depth` | int | 12 | 1–20 |
| `maxThinkingTime` | int ms | 1000 | 50–30000 |
| `variants` | int | 1 | currently informational; one PV is returned |

**Success response**:
```json
{
  "type": "bestmove",
  "move": "e2e4",
  "from": "e2",
  "to": "e4",
  "san": "e4",
  "eval": 0.27,
  "winChance": 53.36,
  "mate": null,
  "continuationArr": ["e7e5", "g1f3"],
  "text": "Best move e4: [+0.27]. The game is balanced. Depth 12."
}
```

**Error response** (200 OK with error envelope, matching chess-api.com's convention):
```json
{ "type": "error", "error": "INVALID_FEN_VALIDATION_ERROR", "text": "Cannot evaluate given position - wrong FEN." }
```

Possible `error` codes: `MISSING_FEN`, `INVALID_FEN_VALIDATION_ERROR`, `NO_MOVE`, `ENGINE_ERROR`.

### `POST /fen`
Board-photo → FEN recognition. Forwards to the Python CNN service in
[`fen-service/`](./fen-service) (set `FEN_SERVICE_URL`; while unset this returns 503 and the
apps fall back to their OpenAI vision path).

**Request body**: `{"image": "<base64 JPEG/PNG>"}` (max ~12MB decoded).

**Success response**:
```json
{
  "fen": "1k6/1pp5/p7/2PP1Q1K/7P/P7/6rr/8 w - - 0 1",
  "placementAsSeen": "8/rr6/7P/P7/K1Q1PP2/7p/5pp1/6k1",
  "boardIsFlipped": true
}
```

`placementAsSeen` is the position exactly as pictured (no orientation correction);
`boardIsFlipped` is the model's statistical guess at whether the diagram is from black's side.
The iOS app decides orientation itself by OCR-ing the printed board coordinates (definitive
when present) and rotating `placementAsSeen` accordingly; `fen` has the server's best guess
applied for simple clients. Errors: `422 {"error": "NO_BOARD" | "BAD_IMAGE" | "IMAGE_TOO_LARGE"}`,
`503/502` when the recognition service is unset/down.

The recognizer is [tsoj/Chess_diagram_to_FEN](https://github.com/tsoj/Chess_diagram_to_FEN)
(MIT), measured at 95% exact-board accuracy / 0.38 wrong squares per board on its real-world
test set, ~1s per image on CPU. **RAM:** the fen-service needs well over 512MB — deploy it on
a ≥2GB instance (see `render.yaml`).

## Deploy with Coolify (docker-compose)

The repo ships a [`docker-compose.yaml`](./docker-compose.yaml) that runs both the Node proxy
and the FEN recognition service as one Coolify resource:

1. Coolify → **New Resource → Docker Compose**, point it at this repo (it reads
   `docker-compose.yaml`).
2. Assign the public domain (e.g. `chessengine.api.ardasen.com`) to the **proxy** service,
   port 3000. `fen-service` needs **no domain** — the proxy reaches it internally as
   `http://fen-service:8000` (already wired via `FEN_SERVICE_URL` in the compose file).
3. Deploy. The first build is slow: the fen-service image bakes in CPU torch and ~900MB of
   model weights, and runs a warmup inference that fails the build if the model is broken.
   Later deploys reuse cached layers unless `fen-service/` changes.
4. Verify: `GET /healthz` → `ok`, then `POST /fen` with `{"image": "<base64>"}` of a board
   screenshot → FEN JSON.

Sizing: ~1–1.5GB RAM for a fen-service inference, a few hundred MB for Node+Stockfish — a
4 vCPU / 8GB box has ample headroom. If you migrate an existing single-Dockerfile Coolify
resource, create the compose resource first, verify it, then move the domain over.

## Deploy to Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → connect the repo. Render reads
   [`render.yaml`](./render.yaml) and provisions a `web` service from the Dockerfile on the free
   plan.
3. After deploy, the URL is something like `https://chess-engine-proxy.onrender.com`. Hit
   `/healthz` to confirm it's up.
4. (Optional) Set up [UptimeRobot](https://uptimerobot.com/) to ping `/healthz` every 5 minutes
   — keeps the free dyno awake so users don't see cold-start delays.

## Local development

Requirements: Node 20+, the `stockfish` binary on PATH (`brew install stockfish` /
`apt-get install stockfish`).

```bash
npm install
npm run dev   # restarts on file change
```

Then:
```bash
curl -X POST http://localhost:3000/v1 \
  -H 'Content-Type: application/json' \
  -d '{"fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","depth":12}'
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3000 | Listen port. Render sets this automatically. |
| `STOCKFISH_PATH` | `stockfish` | Path to the engine binary. Override only if Stockfish is somewhere unusual. |
| `ENGINE_TIMEOUT_MS` | 60000 | Hard timeout after which we SIGTERM Stockfish and 500 the request. Matches the Android app's per-request timeout. |
| `FEN_SERVICE_URL` | *(unset)* | Base URL of the board-photo recognition service. While unset, `POST /fen` returns 503 and the apps fall back to their OpenAI vision path. |
| `WEB_ORIGINS` | *(empty)* | Comma-separated browser origins allowed to call `POST /v1`. Empty means no browser may call it at all. Apex and `www.` are distinct origins — list both. |
| `WEB_MAX_DEPTH` | 16 | Search-depth ceiling for browser traffic. Apps keep the full 20. |
| `WEB_MAX_THINKING_TIME` | 3000 | `movetime` ceiling in ms for browser traffic. This, not the depth cap, is what actually bounds engine CPU. Apps keep 30000. |
| `WEB_RATE_MAX` | 30 | Requests per IP per window, browsers only. |
| `WEB_RATE_WINDOW_MS` | 60000 | Length of that window. |
| `MAX_CONCURRENT_ANALYSES` | 2 | Stockfish processes allowed to run at once. |
| `MAX_QUEUE` | 20 | Requests allowed to wait for a slot before the server sheds with 503 `BUSY`. |
| `CACHE_MAX` | 5000 | Analysed positions kept in memory (LRU). |

## Serving the apps and the website from one box

Every `/v1` request spawns a Stockfish process, so on a small instance CPU and RAM are the
scarce resource and an indexed public site is an unbounded source of load. Four guards keep
website traffic from turning into an app outage:

1. **Position cache** — chess traffic is enormously repetitive, and a hit spawns nothing. It
   is checked *before* the queue, so a cached position never waits for a slot.
2. **Concurrency gate** — at most `MAX_CONCURRENT_ANALYSES` engines run; the rest queue, and
   past `MAX_QUEUE` the server sheds with 503 rather than falling over.
3. **CORS allowlist** — only `WEB_ORIGINS` get CORS headers; other browser origins are refused
   before reaching the engine.
4. **Per-IP rate limit and lower ceilings for browsers**, with `POST /fen` refused outright —
   photo import is what the apps charge credits for, and the CNN service costs far more per
   call than the engine.

Browsers send `Origin` on a cross-origin POST and the native apps do not; that single header
is what tells the two callers apart. **No `Origin` means no rate limit, no CORS check, and the
full depth-20 ceiling, so app behaviour is completely unchanged.** The header is trivially
spoofable, which is fine — these guards bound CPU, they do not authenticate anyone.

`GET /healthz` reports `active`, `queued` and `cached` so a monitor can warn before the queue
starts shedding.

> One caveat worth stating plainly: this is still a single instance shared with the live apps.
> The guards make the website degrade gracefully instead of taking the apps down, but under
> sustained load app users will queue behind web users. A separate instance for web traffic is
> the real fix once the site gets real traffic.

## License

MIT.
