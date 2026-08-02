// Chess analysis proxy. Wraps the system Stockfish binary in a tiny HTTP API whose request/
// response shape matches chess-api.com/v1, so the Chess Engine for Stockfish Android app can
// swap endpoints by changing one constant.
//
// Endpoints:
//   GET  /            - status probe (returns JSON {status:"ok"})
//   GET  /healthz     - liveness probe for UptimeRobot / load balancer
//   GET  /config      - dedicated remote config for the Android app (non-secret tuning knobs)
//   POST /v1          - analyze a FEN, return {move, from, to, san, eval, winChance,
//                        continuationArr, text} on success or {type:"error", error, text} on failure
//
// Env:
//   PORT            - listen port (default 3000)
//   STOCKFISH_PATH  - path to the Stockfish binary (default "stockfish", on PATH)
//   ENGINE_TIMEOUT_MS - hard kill after this many ms if Stockfish hasn't returned bestmove
//                       (default 60000 — matches the Android app's per-request timeout)
//   Remote-config knobs served by GET /config (all optional, fall back to the defaults below):
//   PHOTO_TIMEOUT_MS, PHOTO_MODEL, FREE_CREDITS_COUNT, ANALYSIS_DEPTH,
//   ANALYSIS_MAX_THINKING_TIME, ANALYSIS_VARIANTS

import express from 'express';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';

const ENGINE_BIN = process.env.STOCKFISH_PATH || 'stockfish';
const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 60_000;

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => {
  res.json({ status: 'ok', engine: 'stockfish', endpoint: 'POST /v1' });
});

app.get('/healthz', (_req, res) => {
  // Synchronous, no Stockfish spawn — meant for UptimeRobot to keep the Render free dyno warm.
  res.status(200).type('text/plain').send('ok');
});

// Dedicated remote config for the Chess Engine for Stockfish app. The app fetches this once per
// launch (its REMOTE_CONFIG_URL) to tune non-secret behavior without an app rebuild. Base URLs
// and proxy tokens are NOT here — those live in the separate bootstrap server. Each value is
// env-overridable so it can be changed from the Render dashboard without a code deploy.
const APP_CONFIG = {
  photoAnalyzer: {
    timeoutMs: intFromEnv('PHOTO_TIMEOUT_MS', 30_000),
    // OpenAI vision model for photo→FEN. Swap without an app rebuild — but the model must be
    // allow-listed on the OpenAI proxy and available to the account, or requests 403/404.
    model: process.env.PHOTO_MODEL || 'gpt-4o',
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
  const depth = clamp(body.depth ?? 12, 1, 20);
  const maxThinkingTime = clamp(body.maxThinkingTime ?? 1000, 50, 30_000);

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

    res.json({
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
    });
  } catch (e) {
    console.error('Analysis failed:', e);
    res.status(500).json({
      type: 'error',
      error: 'ENGINE_ERROR',
      text: e?.message || 'Engine error',
    });
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
  console.log(`Chess analysis proxy listening on :${port} (engine=${ENGINE_BIN}, timeout=${ENGINE_TIMEOUT_MS}ms)`);
});
