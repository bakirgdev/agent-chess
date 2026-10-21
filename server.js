import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { Chess } from 'chess.js';
import * as jev from './jev.js';
import * as claude from './claude.js';

const PORT = Number(process.env.PORT ?? 3000);
// Hard cap on what one server run may spend across all engines; restart to reset.
const BUDGET_USD = Number(process.env.BUDGET_USD ?? 1);
// Every engine plays a random legal move instantly, for free (UI testing).
const MOCK = process.env.MOCK === '1';
const ROOT = join(import.meta.dirname, 'public');
const STATIC = {
  '/vendor/chess.js': join(import.meta.dirname, 'node_modules/chess.js/dist/esm/chess.js'),
};
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const JEV_ENGINE = { id: 'jev', label: 'Jev', anthropic: false, model: jev.MODEL };

let spentUsd = 0;

const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
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
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
    return { san: picks[0], confidence: null, candidates: [], thinking, model: engine.id, costUsd: 0 };
  }
  const weights = picks.map(() => Math.random());
  const total = weights.reduce((a, b) => a + b, 0);
  const candidates = picks.map((san, i) => ({ san, p: weights[i] / total })).sort((a, b) => b.p - a.p);
  return { san: candidates[0].san, confidence: candidates[0].p, candidates, thinking: null, model: 'mock', costUsd: 0 };
}

async function decide(chess, player) {
  if (MOCK) return mockDecision(chess, player);
  const { engine, settings } = player;
  if (spentUsd >= BUDGET_USD) {
    throw httpError(402, `Budget of $${BUDGET_USD} reached ($${spentUsd.toFixed(4)} spent); restart the server to reset`);
  }
  try {
    const d = engine.anthropic
      ? await claude.chooseMove(chess, engine, settings, BUDGET_USD - spentUsd)
      : await jev.chooseMove(chess);
    spentUsd += d.costUsd;
    return { confidence: null, candidates: [], thinking: null, ...d };
  } catch (err) {
    // Failed calls can still be billed (refusals, token-limit stops, bad answers).
    spentUsd += err.costUsd ?? 0;
    throw err;
  }
}

async function handleMove(req, res) {
  const body = await readJson(req);
  const chess = replay(body.moves);
  const player = await parsePlayer(body.player);
  const started = Date.now();
  const decision = await decide(chess, player);
  send(res, 200, { ...decision, spentUsd, ms: Date.now() - started });
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

async function serveStatic(req, res) {
  const path = new URL(req.url, 'http://x').pathname;
  const file = STATIC[path] ?? join(ROOT, normalize(path === '/' ? '/index.html' : path));
  if (!file.startsWith(ROOT) && !Object.values(STATIC).includes(file)) return send(res, 404, { error: 'Not found' });
  try {
    send(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
    send(res, 404, { error: 'Not found' });
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/move') return await handleMove(req, res);
    if (req.method === 'GET' && req.url === '/api/config') return await handleConfig(res);
    if (req.method === 'GET') return await serveStatic(req, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    const status = err.status ?? (err instanceof SyntaxError ? 400 : 502);
    if (status >= 500) console.error(err);
    send(res, status, { error: err.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Jev chess on http://localhost:${PORT}${MOCK ? ' (MOCK)' : ''}`));
