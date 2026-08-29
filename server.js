// Chess analysis proxy. Wraps the system Stockfish binary in a tiny HTTP API whose request/
// response shape matches chess-api.com/v1, so the Chess Engine for Stockfish Android app can
// swap endpoints by changing one constant.
//
// Serves two very different callers:
//   - the iOS/Android apps, which send a bounded number of requests per user session
//   - the public website, which is indexed and therefore reachable by anyone, including bots
//
// The website is the reason for the four guards below. Every /v1 request spawns a Stockfish
// process, and on a small dyno that is the scarce resource — so the file caches repeated
// positions, caps how many engines run at once, rate-limits browser traffic, and keeps the
// photo endpoint app-only. Without those, a good day for the website is an outage for the app.
//
// Endpoints:
//   GET  /            - status probe (returns JSON {status:"ok"})
//   GET  /healthz     - liveness probe for UptimeRobot / load balancer
//   GET  /config      - dedicated remote config for the Android app (non-secret tuning knobs)
//   POST /v1          - analyze a FEN, return {move, from, to, san, eval, winChance,
//                        continuationArr, text} on success or {type:"error", error, text} on failure
//   POST /fen         - board-photo FEN recognition; apps only, never the website
//
// Env:
//   PORT            - listen port (default 3000)
//   STOCKFISH_PATH  - path to the Stockfish binary (default "stockfish", on PATH)
//   ENGINE_TIMEOUT_MS - hard kill after this many ms if Stockfish hasn't returned bestmove
//                       (default 60000 — matches the Android app's per-request timeout)
//   WEB_ORIGINS     - comma-separated site origins allowed to call /v1 from a browser.
//                     Empty (default) means no browser may call it at all.
//   WEB_MAX_DEPTH   - depth ceiling for browser traffic (default 16). Apps keep the full 20.
//   WEB_MAX_THINKING_TIME - movetime ceiling for browser traffic in ms (default 3000). This,
//                     not the depth cap, is what actually bounds engine CPU. Apps keep 30000.
//   WEB_RATE_MAX / WEB_RATE_WINDOW_MS - per-IP browser budget (default 30 per 60s)
//   MAX_CONCURRENT_ANALYSES - Stockfish processes allowed at once (default 2)
//   MAX_QUEUE       - requests allowed to wait for a slot (default 20)
//   CACHE_MAX       - analysed positions kept in memory (default 5000)
//   Remote-config knobs served by GET /config (all optional, fall back to the defaults below):
//   PHOTO_TIMEOUT_MS, FREE_CREDITS_COUNT, ANALYSIS_DEPTH, ANALYSIS_MAX_THINKING_TIME,
//   ANALYSIS_VARIANTS

import express from 'express';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';

const ENGINE_BIN = process.env.STOCKFISH_PATH || 'stockfish';
const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 60_000;
const FEN_SERVICE_URL = process.env.FEN_SERVICE_URL || '';

const WEB_ORIGINS = (process.env.WEB_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const WEB_MAX_DEPTH = intFromEnv('WEB_MAX_DEPTH', 16);
const WEB_MAX_THINKING_TIME = intFromEnv('WEB_MAX_THINKING_TIME', 3_000);
const WEB_RATE_MAX = intFromEnv('WEB_RATE_MAX', 30);
const WEB_RATE_WINDOW_MS = intFromEnv('WEB_RATE_WINDOW_MS', 60_000);
const MAX_CONCURRENT = intFromEnv('MAX_CONCURRENT_ANALYSES', 2);
const MAX_QUEUE = intFromEnv('MAX_QUEUE', 20);
const CACHE_MAX = intFromEnv('CACHE_MAX', 5000);

const app = express();

// One reverse proxy terminates TLS in front of this (Traefik under Coolify, Render's router
// on Render). Without this, req.ip is that proxy and every browser on earth shares a single
// rate-limit bucket. The value is the hop count: raise it only if you add another proxy,
// since each hop trusted is one more X-Forwarded-For entry a client could have forged.
app.set('trust proxy', 1);

/**
 * Browsers announce themselves with Origin on a cross-origin POST; the native apps do not
 * send one. That single header is what separates the two callers, and it decides the CORS
 * answer, the depth ceiling and the rate limit. It is trivially spoofable, which is fine —
 * these guards exist to bound CPU, not to authenticate anyone.
 */
function webOrigin(req) {
  const origin = req.get('origin');
  return origin && WEB_ORIGINS.includes(origin) ? origin : null;
}

app.use((req, res, next) => {
  const allowed = webOrigin(req);
  // Unconditional: the response body differs by Origin (403 vs. 200), so any cache in front
  // of this must key on it. Setting Vary only on the allowed branch is how a CDN ends up
  // serving a browser the header-less response it cached for someone else.
  res.set('Vary', 'Origin');
  if (allowed) {
    res.set('Access-Control-Allow-Origin', allowed);
    // POST is a CORS-safelisted method, so preflight happens to pass without this — but only
    // by accident of the spec. State it, so the site keeps working if a call ever isn't POST.
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'content-type');
    res.set('Access-Control-Max-Age', '86400');
  }
  // Answer the preflight here so it never reaches a handler or the engine.
  if (req.method === 'OPTIONS') return res.sendStatus(allowed ? 204 : 403);
  next();
});

// ---------------------------------------------------------------------------
// Per-IP rate limit, browser traffic only.
//
// In-memory on purpose: this runs as a single instance, and a limiter that forgets
// everything on restart is the right trade for one that needs Redis to boot.
// ---------------------------------------------------------------------------
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const seen = hits.get(ip);
  if (!seen || now >= seen.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WEB_RATE_WINDOW_MS });
    return false;
  }
  seen.count += 1;
  return seen.count > WEB_RATE_MAX;
}

// Sweep expired buckets so a long uptime under bot traffic cannot grow the map without end.
setInterval(() => {
  const now = Date.now();
  for (const [ip, seen] of hits) if (now >= seen.resetAt) hits.delete(ip);
}, WEB_RATE_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// Position cache.
//
// The highest-leverage guard by far. Chess traffic is enormously repetitive — openings,
// puzzles, whatever position an article happens to feature — so most website requests are
// for a position the engine has already solved. A hit costs nothing and spawns nothing.
// ---------------------------------------------------------------------------
const cache = new Map();

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key);
  cache.delete(key);
  cache.set(key, value); // reinsert: Map iterates in insertion order, so this is the LRU bump
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------------------
// Concurrency gate.
//
// Nothing else here bounds memory. Each analysis spawns a real Stockfish process, so N
// simultaneous requests means N engines competing for one small CPU: every caller gets a
// slower answer and enough of them exhaust the box. Queue instead, and shed load once the
// queue is longer than anyone would wait for.
// ---------------------------------------------------------------------------
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve(true);
  }
  if (waiting.length >= MAX_QUEUE) return Promise.resolve(false);
  return new Promise((resolve) => waiting.push(resolve));
}

function release() {
  const next = waiting.shift();
  if (next) next(true); // hand the slot straight over rather than decrementing and re-incrementing
  else active -= 1;
}

// Board-photo FEN recognition, forwarded to the Python CNN service (fen-service/). Mounted
// BEFORE the global JSON parser: photos exceed its 256kb limit, so this route parses its own
// body. Returns non-200 when the service is unset or down — the apps then fall back to their
// OpenAI vision path, so this endpoint failing never breaks imports outright.
//
// Browsers are refused outright. Photo import is what the apps charge credits for, and the
// CNN service is far more expensive per call than the engine.
app.post('/fen', express.json({ limit: '16mb' }), async (req, res) => {
  if (req.get('origin')) {
    return res.status(403).json({ error: 'APP_ONLY', text: 'Photo import is available in the app.' });
  }
  if (!FEN_SERVICE_URL) {
    return res.status(503).json({ error: 'FEN_SERVICE_NOT_CONFIGURED' });
  }
  try {
    const upstream = await fetch(`${FEN_SERVICE_URL.replace(/\/$/, '')}/fen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      // Generous: a sleeping free-tier dyno cold-starts slower than it infers.
      signal: AbortSignal.timeout(90_000),
    });
    const body = await upstream.text();
    res.status(upstream.status).type('application/json').send(body);
  } catch (e) {
    console.error('FEN forward failed:', e?.message || e);
    res.status(502).json({ error: 'FEN_SERVICE_UNAVAILABLE' });
  }
});

app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', engine: 'stockfish', endpoint: 'POST /v1' });
});

app.get('/healthz', (_req, res) => {
  // Synchronous, no Stockfish spawn — meant for UptimeRobot to keep the Render free dyno warm.
  // Reports load so a monitor can alert before the queue starts shedding.
  res.status(200).type('text/plain').send(`ok active=${active} queued=${waiting.length} cached=${cache.size}`);
});

// Dedicated remote config for the Chess Engine for Stockfish app. The app fetches this once per
// launch (its REMOTE_CONFIG_URL) to tune non-secret behavior without an app rebuild. Base URLs
// and proxy tokens are NOT here — those live in the separate bootstrap server. Each value is
// env-overridable so it can be changed from the Render dashboard without a code deploy.
const APP_CONFIG = {
  photoAnalyzer: {
    timeoutMs: intFromEnv('PHOTO_TIMEOUT_MS', 30_000),
  },
  freeCreditsCount: intFromEnv('FREE_CREDITS_COUNT', 3),
  analysisDefaults: {
    depth: intFromEnv('ANALYSIS_DEPTH', 18),
    maxThinkingTime: intFromEnv('ANALYSIS_MAX_THINKING_TIME', 100),
    variants: intFromEnv('ANALYSIS_VARIANTS', 1),
  },
};

app.get('/config', (_req, res) => {
  res.json(APP_CONFIG);
});

app.post('/v1', async (req, res) => {
  const body = req.body || {};
  const fen = body.fen;
  const fromWeb = webOrigin(req) !== null;

  // Whether the caller is still there. `req.destroyed` looks like the obvious check and is
  // the wrong one: Node destroys the request stream once its body has been read, which
  // express.json already did above, so it is true on every healthy request. The response's
  // close event fires on a normal finish too, so writableEnded is what actually separates
  // "client gave up" from "we answered it".
  let clientGone = false;
  res.on('close', () => { clientGone = !res.writableEnded; });

  // A browser that is not on the allowlist never reaches the engine.
  if (req.get('origin') && !fromWeb) {
    return res.status(403).json({ type: 'error', error: 'ORIGIN_NOT_ALLOWED', text: 'Origin not allowed.' });
  }
  if (fromWeb && rateLimited(req.ip)) {
    res.set('Retry-After', String(Math.ceil(WEB_RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ type: 'error', error: 'RATE_LIMITED', text: 'Too many requests. Try again shortly.' });
  }

  const ceiling = fromWeb ? Math.min(WEB_MAX_DEPTH, 20) : 20;
  const depth = clamp(body.depth ?? 12, 1, ceiling);
  // Stockfish stops at whichever of `depth` and `movetime` comes first, so on a position it
  // searches quickly the depth cap costs a web caller nothing — movetime is the ceiling that
  // actually holds a slot. Cap it too, or one allowlisted IP can pin both engines for the
  // whole rate-limit window on deliberately hard positions.
  const timeCeiling = fromWeb ? Math.min(WEB_MAX_THINKING_TIME, 30_000) : 30_000;
  const maxThinkingTime = clamp(body.maxThinkingTime ?? 1000, 50, timeCeiling);

  if (!fen || typeof fen !== 'string') {
    return res.json({ type: 'error', error: 'MISSING_FEN', text: 'fen is required.' });
  }

  // Validate FEN client-side via chess.js. Mirrors chess-api.com's INVALID_FEN_VALIDATION_ERROR
  // so the Android app's existing strict-FEN gating works unchanged.
  let chess;
  try {
    chess = new Chess(fen);
  } catch {
    return res.json({
      type: 'error',
      error: 'INVALID_FEN_VALIDATION_ERROR',
      text: 'Cannot evaluate given position - wrong FEN.',
    });
  }

  // Checked before the queue and before any spawn: a cached position must never wait for a slot.
  const key = `${fen}|${depth}|${maxThinkingTime}`;
  const hit = cacheGet(key);
  if (hit) {
    res.set('X-Cache', 'HIT');
    return res.json(hit);
  }

  const slot = await acquire();
  if (!slot) {
    res.set('Retry-After', '5');
    return res.status(503).json({ type: 'error', error: 'BUSY', text: 'Engine is busy. Try again in a moment.' });
  }

  // A request can sit in the queue for minutes when the gate is saturated, and the app's own
  // 60s timeout fires well before that. Spawning an engine for a socket nobody is still
  // reading is exactly the waste the gate exists to prevent, so pass the slot straight on.
  if (clientGone) {
    release();
    return;
  }

  try {
    const result = await analyze(fen, depth, maxThinkingTime);
    if (!result.bestmove || result.bestmove === '(none)') {
      return res.json({ type: 'error', error: 'NO_MOVE', text: 'Engine returned no move.' });
    }

    const from = result.bestmove.slice(0, 2);
    const to = result.bestmove.slice(2, 4);
    const promo = result.bestmove.length === 5 ? result.bestmove[4] : undefined;

    // Derive SAN by playing the move on the chess.js board. Wrapped in try/catch — promotion
    // edge cases or stalemate-after-move shouldn't fail the whole request.
    let san = result.bestmove;
    try {
      const move = chess.move({ from, to, promotion: promo });
      if (move?.san) san = move.san;
    } catch { /* fall back to UCI */ }

    const evalForResponse = result.mate !== undefined ? null : result.eval ?? null;
    const winChance = evalForResponse !== null
      ? round(50 + 50 * Math.tanh(evalForResponse / 2), 2)
      : (result.mate !== undefined ? (result.mate > 0 ? 99 : 1) : null);

    // The UCI principal variation starts at the *current* position — so pv[0] is the
    // bestmove itself. chess-api.com strips that prefix from continuationArr so consumers
    // can render "best move X, then continuation Y Z W..." without duplicating X. Match
    // that convention so the Android paywall's chip row doesn't show the bestmove twice.
    const pv = result.pv ?? [];
    const continuationArr = pv.length > 0 && pv[0] === result.bestmove ? pv.slice(1) : pv;

    const payload = {
      type: 'bestmove',
      move: result.bestmove,
      from,
      to,
      san,
      eval: evalForResponse,
      winChance,
      mate: result.mate ?? null,
      continuationArr,
      text: describe(san, evalForResponse, result.mate, depth),
    };
    cacheSet(key, payload);
    res.set('X-Cache', 'MISS');
    res.json(payload);
  } catch (e) {
    console.error('Analysis failed:', e);
    res.status(500).json({
      type: 'error',
      error: 'ENGINE_ERROR',
      text: e?.message || 'Engine error',
    });
  } finally {
    // In finally, not after res.json: an early return or a throw above would otherwise leak
    // the slot, and a leaked slot is permanent — the gate closes for good.
    release();
  }
});

/**
 * Spawn a one-shot Stockfish subprocess, send a UCI position+go, parse the streamed `info` lines
 * for eval/pv, and resolve on `bestmove`. Killed after [ENGINE_TIMEOUT_MS] if no answer.
 */
function analyze(fen, depth, maxThinkingTime) {
  return new Promise((resolve, reject) => {
    let sf;
    try {
      sf = spawn(ENGINE_BIN);
    } catch (e) {
      return reject(new Error(`Cannot launch Stockfish: ${e.message}`));
    }

    const result = { pv: [] };
    let buffer = '';
    let resolved = false;

    const finish = (err) => {
      if (resolved) return;
      resolved = true;
      try { sf.stdin.write('quit\n'); } catch { /* ignore */ }
      try { sf.kill('SIGTERM'); } catch { /* ignore */ }
      if (err) reject(err); else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error('Engine timeout')), ENGINE_TIMEOUT_MS);

    sf.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith('info ')) {
          const cp = line.match(/\bscore cp (-?\d+)/);
          const mate = line.match(/\bscore mate (-?\d+)/);
          const pv = line.match(/\bpv (.+)$/);
          if (cp) result.eval = parseInt(cp[1], 10) / 100;
          if (mate) result.mate = parseInt(mate[1], 10);
          if (pv) result.pv = pv[1].trim().split(/\s+/);
        } else if (line.startsWith('bestmove')) {
          result.bestmove = line.split(/\s+/)[1];
          clearTimeout(timer);
          finish();
        }
      }
    });

    sf.on('error', (err) => {
      clearTimeout(timer);
      finish(new Error(`Engine spawn failed: ${err.message}`));
    });

    sf.on('exit', () => {
      clearTimeout(timer);
      if (!resolved && !result.bestmove) finish(new Error('Engine exited unexpectedly'));
    });

    try {
      sf.stdin.write('uci\n');
      sf.stdin.write('isready\n');
      sf.stdin.write(`position fen ${fen}\n`);
      sf.stdin.write(`go depth ${depth} movetime ${maxThinkingTime}\n`);
    } catch (e) {
      clearTimeout(timer);
      finish(new Error(`Failed to write UCI commands: ${e.message}`));
    }
  });
}

// Parse an integer env var, falling back to [fallback] when unset or not a finite number.
function intFromEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

function round(value, places) {
  const f = Math.pow(10, places);
  return Math.round(value * f) / f;
}

function describe(san, evalCp, mate, depth) {
  if (mate !== undefined && mate !== null) {
    return `Best move ${san} (mate in ${Math.abs(mate)}). Depth ${depth}.`;
  }
  if (evalCp === null || evalCp === undefined) return `Best move ${san}. Depth ${depth}.`;
  const sign = evalCp >= 0 ? '+' : '';
  const verdict = Math.abs(evalCp) < 0.3 ? 'The game is balanced.'
    : evalCp > 0 ? 'White is better.' : 'Black is better.';
  return `Best move ${san}: [${sign}${evalCp.toFixed(2)}]. ${verdict} Depth ${depth}.`;
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(
    `Chess analysis proxy listening on :${port} (engine=${ENGINE_BIN}, timeout=${ENGINE_TIMEOUT_MS}ms, ` +
    `concurrency=${MAX_CONCURRENT}, web origins=${WEB_ORIGINS.length ? WEB_ORIGINS.join(' ') : 'none'})`,
  );
});
