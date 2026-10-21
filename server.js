import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Chess } from 'chess.js';
import { httpError } from './errors.js';
import * as jev from './jev.js';
import * as claude from './claude.js';

const PORT = Number(process.env.PORT ?? 3000);
// Hard cap on what one server run may spend across all engines; restart to reset.
const BUDGET_USD = Number(process.env.BUDGET_USD ?? 1);
// Every engine plays a random legal move instantly, for free (UI testing).
const MOCK = process.env.MOCK === '1';

if (!Number.isInteger(PORT) || PORT <= 0) throw new Error(`PORT must be a positive integer, got "${process.env.PORT}"`);
if (!Number.isFinite(BUDGET_USD) || BUDGET_USD < 0) {
  throw new Error(`BUDGET_USD must be a non-negative number, got "${process.env.BUDGET_USD}"`);
}

const ROOT = join(import.meta.dirname, 'public');
const VENDOR = { '/vendor/chess.js': join(import.meta.dirname, 'node_modules/chess.js/dist/esm/chess.js') };
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// The API spends real money, so only this app's own page may call it: the Host check defeats DNS
// rebinding, and requiring a JSON content type forces a CORS preflight that other sites never pass.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((host) => `http://${host}`));
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

const JEV_ENGINE = { id: 'jev', label: 'Jev', anthropic: false, model: jev.MODEL };

let spentUsd = 0;
// Moves run one at a time so concurrent requests (two tabs) can't each spend the remaining budget.
let queue = Promise.resolve();

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'Body too large');
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Body is not valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw httpError(400, 'Body must be a JSON object');
  return body;
}

// Rebuild the game from the SAN history so the server, not the client, decides what is legal.
function replay(moves) {
  if (!Array.isArray(moves) || moves.length > 1000 || !moves.every((m) => typeof m === 'string')) {
    throw httpError(400, 'moves must be an array of SAN strings');
  }
  const chess = new Chess();
  for (const san of moves) {
    try {
      chess.move(san);
    } catch {
      throw httpError(400, `Illegal move in history: ${san}`);
    }
  }
  if (chess.isGameOver()) throw httpError(400, 'Game is already over');
  return chess;
}

async function parsePlayer(player) {
  if (player?.engine === 'jev') return { engine: JEV_ENGINE, settings: {} };
  const engine = (await claude.listEngines()).find((e) => e.id === player?.engine);
  if (!engine) throw httpError(400, `Unknown engine: ${player?.engine}`);
  return { engine, settings: claude.parsePlayer(engine, player) };
}

function mockDecision(chess, { engine, settings }) {
  const picks = chess.moves().toSorted(() => Math.random() - 0.5).slice(0, 5);
  if (engine.anthropic) {
    const thinking = settings.thinking === 'off' ? null : `Mock reasoning: ${picks[0]} looks reasonable here.`;
    return { san: picks[0], thinking, model: engine.id, costUsd: 0 };
  }
  const weights = picks.map(() => Math.random());
  const total = weights.reduce((a, b) => a + b, 0);
  const candidates = picks.map((san, i) => ({ san, p: weights[i] / total })).sort((a, b) => b.p - a.p);
  return { san: candidates[0].san, confidence: candidates[0].p, candidates, model: 'mock', costUsd: 0 };
}

async function decide(chess, { engine, settings }) {
  if (MOCK) return mockDecision(chess, { engine, settings });
  if (spentUsd >= BUDGET_USD) {
    throw httpError(402, `Budget of $${BUDGET_USD} reached ($${spentUsd.toFixed(4)} spent); restart the server to reset`);
  }
  try {
    const d = engine.anthropic ? await claude.chooseMove(chess, engine, settings, BUDGET_USD - spentUsd) : await jev.chooseMove(chess);
    spentUsd += d.costUsd;
    return d;
  } catch (err) {
    // Failed calls can still be billed (refusals, token-limit stops, bad answers).
    spentUsd += err.costUsd ?? 0;
    throw err;
  }
}

async function handleMove(req, res) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw httpError(415, 'Content-Type must be application/json');
  let clientGone = false;
  res.on('close', () => {
    clientGone = !res.writableFinished;
  });
  const body = await readJson(req);
  const chess = replay(body.moves);
  const player = await parsePlayer(body.player);

  // A call already running is finished and billed even if the client leaves; a queued one is skipped.
  const turn = queue.then(async () => {
    if (clientGone) return null;
    const started = Date.now();
    const decision = await decide(chess, player);
    return { confidence: null, candidates: [], thinking: null, ...decision, ms: Date.now() - started };
  });
  // Keep the queue alive after a failed move; the failure still reaches this request through `turn`.
  queue = turn.catch(() => {});
  const result = await turn;
  if (result) send(res, 200, { ...result, spentUsd });
}

async function handleConfig(res) {
  let claudeEngines = [];
  let anthropicError = null;
  try {
    claudeEngines = (await claude.listEngines()).map(claude.publicEngine);
  } catch (err) {
    // Jev stays playable without an Anthropic key; the UI shows why the Claude models are missing.
    console.error('Could not list Anthropic models:', err.message);
    anthropicError = err.message;
  }
  send(res, 200, {
    engines: [JEV_ENGINE, ...claudeEngines],
    anthropicError,
    effortsWithoutThinking: claude.EFFORTS_WITHOUT_THINKING,
    budgetTokensOptions: claude.BUDGET_TOKENS,
    budgetUsd: BUDGET_USD,
    spentUsd,
  });
}

function staticFile(pathname) {
  if (Object.hasOwn(VENDOR, pathname)) return VENDOR[pathname];
  const file = join(ROOT, normalize(pathname === '/' ? '/index.html' : pathname));
  return file.startsWith(ROOT + sep) ? file : null;
}

async function serveStatic(pathname, res) {
  const file = staticFile(pathname);
  if (!file) return send(res, 404, { error: 'Not found' });
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
    send(res, 404, { error: 'Not found' });
  }
}

createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host)) throw httpError(403, 'Unexpected Host header');
    if (req.headers.origin !== undefined && !ORIGINS.has(req.headers.origin)) throw httpError(403, 'Cross-origin request refused');
    if (!URL.canParse(req.url, 'http://localhost')) throw httpError(400, 'Malformed URL');
    const { pathname } = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && pathname === '/api/move') return await handleMove(req, res);
    if (req.method === 'GET' && pathname === '/api/config') return await handleConfig(res);
    if (req.method === 'GET') return await serveStatic(pathname, res);
    throw httpError(405, 'Method not allowed');
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) send(res, status, { error: err.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Agent Chess on http://localhost:${PORT}${MOCK ? ' (MOCK)' : ''}`));
