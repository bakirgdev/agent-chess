import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Chess } from 'chess.js';

const PORT = 40000 + Math.floor(Math.random() * 10000);
const HOST = `127.0.0.1:${PORT}`;
let server;

before(async () => {
  // Mock mode with no usable keys: no test can reach a paid API.
  const env = { ...process.env, MOCK: '1', PORT: String(PORT), ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
    // Pretend native Stockfish is missing, so results don't depend on what this machine has installed.
    STOCKFISH_PATH: '/nonexistent/stockfish' };
  delete env.TYPESAFE_API_KEY;
  server = spawn(process.execPath, ['server.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.setEncoding('utf8');
  let out = '';
  while (!out.includes('Agent Chess on')) {
    const [chunk] = await once(server.stdout, 'data');
    out += chunk;
  }
});

after(() => server.kill());

function request(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: PORT, method, path, headers: { host: HOST, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const postJson = (path, payload, headers = {}) =>
  request('POST', path, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });

test('serves the page with security headers', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /<title>Agent Chess<\/title>/);
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('serves chess.js to the browser', async () => {
  const res = await request('GET', '/vendor/chess.js');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/javascript/);
});

test('does not serve files outside public/', async () => {
  for (const path of ['/../server.js', '/%2e%2e/server.js', '/..%2fserver.js', '/.env']) {
    assert.equal((await request('GET', path)).status, 404, path);
  }
});

test('config lists Jev even when Anthropic is unreachable', async () => {
  const res = await request('GET', '/api/config');
  assert.equal(res.status, 200);
  const config = JSON.parse(res.body);
  assert.equal(config.engines[0].id, 'jev');
  assert.equal(typeof config.anthropicError, 'string');
  assert.equal(config.budgetUsd, 1);
});

test('plays a legal move for the side to move', async () => {
  const moves = ['e4', 'e5', 'Nf3'];
  const res = await postJson('/api/move', { moves, player: { engine: 'jev' } });
  assert.equal(res.status, 200);
  const { san, spentUsd } = JSON.parse(res.body);
  const chess = new Chess();
  for (const m of moves) chess.move(m);
  assert.equal(chess.turn(), 'b');
  assert.ok(chess.moves().includes(san), `${san} is legal`);
  assert.equal(spentUsd, 0);
});

test('rejects illegal or finished games', async () => {
  assert.equal((await postJson('/api/move', { moves: ['e4', 'Ke2x'], player: { engine: 'jev' } })).status, 400);
  const foolsMate = ['f3', 'e5', 'g4', 'Qh4#'];
  assert.equal((await postJson('/api/move', { moves: foolsMate, player: { engine: 'jev' } })).status, 400);
});

test('plays a legal move from a custom FEN', async () => {
  const fen = '8/8/8/8/8/5k2/8/K6R b - - 0 40';
  const res = await postJson('/api/move', { fen, moves: [], player: { engine: 'jev' } });
  assert.equal(res.status, 200);
  assert.ok(new Chess(fen).moves().includes(JSON.parse(res.body).san));
  const after = await postJson('/api/move', { fen, moves: ['Ke3', 'Rh3+'], player: { engine: 'jev' } });
  assert.equal(after.status, 200);
});

test('rejects a bad, finished or non-string FEN', async () => {
  const player = { engine: 'jev' };
  const invalid = await postJson('/api/move', { fen: 'not a fen', moves: [], player });
  assert.equal(invalid.status, 400);
  assert.match(JSON.parse(invalid.body).error, /^Invalid FEN: /);
  const mated = '7k/6Q1/6K1/8/8/8/8/8 b - - 0 1';
  assert.equal((await postJson('/api/move', { fen: mated, moves: [], player })).status, 400);
  for (const fen of [42, null, ['8/8/8/8/8/8/8/K6k w - - 0 1'], 'x'.repeat(101)]) {
    assert.equal((await postJson('/api/move', { fen, moves: [], player })).status, 400, JSON.stringify(fen));
  }
});

test('rejects malformed bodies', async () => {
  const bad = (body) => request('POST', '/api/move', { headers: { 'content-type': 'application/json' }, body });
  assert.equal((await bad('{not json')).status, 400);
  assert.equal((await bad('null')).status, 400);
  assert.equal((await bad('{"moves":"e4"}')).status, 400);
});

test('native analysis reports itself unavailable when Stockfish is missing', async () => {
  assert.equal(JSON.parse((await request('GET', '/api/config')).body).stockfish, false);
  const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
  assert.equal((await postJson('/api/eval', { fen })).status, 503);
  assert.equal((await postJson('/api/eval', { fen: 'not a fen' })).status, 400);
  assert.equal((await postJson('/api/eval', { fen }, { origin: 'https://evil.example' })).status, 403);
});

test('rejects a position where the side not to move is in check', async () => {
  // chess.js accepts this FEN, but Stockfish crashes on it.
  const fen = '4k3/8/8/8/8/8/4R3/4K3 w - - 0 1';
  for (const [path, payload] of [['/api/eval', { fen }], ['/api/move', { fen, moves: [], player: { engine: 'jev' } }]]) {
    const res = await postJson(path, payload);
    assert.equal(res.status, 400, path);
    assert.match(JSON.parse(res.body).error, /^Illegal position: /);
  }
});

// A web page can send a text/plain POST without a CORS preflight; only JSON is accepted.
test('refuses requests that skip the CORS preflight', async () => {
  const body = JSON.stringify({ moves: [], player: { engine: 'jev' }, fen: '8/8/8/8/8/8/8/K6k w - - 0 1' });
  for (const [path, headers] of [['/api/move', { 'content-type': 'text/plain' }], ['/api/eval', {}]]) {
    assert.equal((await request('POST', path, { headers, body })).status, 415, path);
  }
});

test('refuses cross-origin and DNS-rebinding requests', async () => {
  const payload = { moves: [], player: { engine: 'jev' } };
  assert.equal((await postJson('/api/move', payload, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await postJson('/api/move', payload, { host: `evil.example:${PORT}` })).status, 403);
  assert.equal((await request('GET', '/api/config', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await postJson('/api/move', payload, { origin: `http://localhost:${PORT}` })).status, 200);
});
