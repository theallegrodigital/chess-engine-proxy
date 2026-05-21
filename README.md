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

## License

MIT.
