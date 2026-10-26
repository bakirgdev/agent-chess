import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildRequest } from '../jev.js';
import { parsePlayer, prompt, publicEngine } from '../claude.js';
import { uciClient } from '../public/uci.js';
import { illegalPositionReason, movetext } from '../public/chessutil.js';

const play = (...moves) => {
  const chess = new Chess();
  for (const m of moves) chess.move(m);
  return chess;
};

test('Jev gets every legal move as an option, and only those', () => {
  const chess = play('e4', 'e5', 'Nf3');
  const { criteria } = buildRequest(chess).questions.move;
  assert.deepEqual(Object.keys(criteria).sort(), chess.moves().sort());
  // Building the request plays and undoes each move; the game must be untouched.
  assert.deepEqual(chess.history(), ['e4', 'e5', 'Nf3']);
});

test('Jev option facts flag mate, material loss and repetition', () => {
  const mate = buildRequest(play('e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6')).questions.move.criteria;
  assert.match(mate['Qxf7#'].result, /checkmate/);

  const blunder = buildRequest(play('e4', 'Nf6', 'e5', 'Nd5', 'Nc3', 'Nxc3', 'dxc3', 'Nc6', 'Nf3', 'e6')).questions.move.criteria;
  assert.equal(blunder['Qxd7+'].likely_material_result, 'loses about 8 pawn(s) worth');
  assert.equal(blunder['Qxd7+'].gives_check, true);

  const repeat = buildRequest(play('Nf3', 'Nf6', 'Ng1', 'Ng8')).questions.move.criteria;
  assert.equal(repeat.Nf3.repeats_earlier_position, true);
  assert.equal(repeat.Nc3.repeats_earlier_position, undefined);
});

const sonnet = {
  id: 'claude-sonnet-5-5',
  label: 'Claude Sonnet 5.5',
  anthropic: true,
  thinking: ['adaptive', 'off'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  fast: false,
  offType: 'between_tools',
  maxTokens: 128000,
};

test('Claude settings are validated against the model capabilities', () => {
  assert.deepEqual(parsePlayer(sonnet, { thinking: 'adaptive', effort: 'max' }), {
    thinking: 'adaptive',
    effort: 'max',
    budgetTokens: null,
    fast: false,
  });
  assert.throws(() => parsePlayer(sonnet, { thinking: 'off', effort: 'max' }), /effort must be one of low, medium, high/);
  assert.throws(() => parsePlayer(sonnet, { thinking: 'budget', effort: 'low', budgetTokens: 4096 }), /supports thinking/);
  assert.throws(() => parsePlayer(sonnet, { thinking: 'adaptive', effort: 'low', fast: true }), /no fast mode/);
  assert.throws(() => parsePlayer(sonnet, { thinking: 'adaptive', effort: 'turbo' }), /effort must be one of/);
});

test('server-only engine fields are not sent to the browser', () => {
  const shown = publicEngine(sonnet);
  assert.equal(shown.offType, undefined);
  assert.equal(shown.maxTokens, undefined);
  assert.equal(shown.id, sonnet.id);
});

test('Claude prompt numbers moves from the start position', () => {
  assert.match(prompt(play('e4', 'e5', 'Nf3')), /Game so far: 1\. e4 e5 2\. Nf3\n/);
  assert.match(prompt(new Chess()), /Game so far: no moves yet/);
});

test('Claude prompt numbers moves from a custom start with Black to move', () => {
  const chess = new Chess('8/8/8/8/8/5k2/8/K6R b - - 0 40');
  chess.move('Ke3');
  chess.move('Rh3+');
  chess.move('Kd2');
  assert.match(prompt(chess), /Game so far: 40\.\.\. Ke3 41\. Rh3\+ Kd2\n/);
  assert.match(prompt(chess), /It is move 42,/);
});

test('UCI client keeps the deepest exact score per line and resolves on bestmove', async () => {
  const sent = [];
  const uci = uciClient((cmd) => sent.push(cmd));
  const result = uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 100, multipv: 2 });
  await Promise.resolve();
  assert.deepEqual(sent, ['setoption name MultiPV value 2', 'position fen 8/8/8/8/8/5k2/8/K6R w - - 0 1', 'go movetime 100']);
  for (const line of [
    'info depth 10 seldepth 12 multipv 1 score cp 520 nodes 1 pv h1h3 f3e4',
    'info depth 11 seldepth 12 multipv 1 score cp 900 lowerbound nodes 2 pv h1h2',
    'info depth 11 seldepth 13 multipv 1 score mate 12 nodes 3 pv h1h4 f3e3',
    'info depth 11 seldepth 13 multipv 2 score cp 480 nodes 3 pv a1b2 f3e4',
    'bestmove h1h4 ponder f3e3',
  ]) uci.feed(line);
  assert.deepEqual(await result, {
    depth: 11,
    lines: [{ move: 'h1h4', cp: null, mate: 12 }, { move: 'a1b2', cp: 480, mate: null }],
  });
});

test('UCI client rejects a search whose send throws, and the next one still runs', async () => {
  let broken = true;
  const sent = [];
  const uci = uciClient((cmd) => {
    if (broken) throw new Error('Stockfish is not running');
    sent.push(cmd);
  });
  await assert.rejects(uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 10, multipv: 1 }), /not running/);
  broken = false;
  const next = uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 10, multipv: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 3);
  uci.feed('bestmove h1h2');
  assert.deepEqual(await next, { depth: 0, lines: [] });
});

test('UCI client rejects a search the engine never answers', async () => {
  const uci = uciClient(() => {}, 20);
  await assert.rejects(uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 1, multipv: 1 }), /did not answer in time/);
  // The timed-out search is gone: a late bestmove must not throw, and the next search runs.
  uci.feed('bestmove h1h2');
  const next = uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 1, multipv: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  uci.feed('bestmove h1h2');
  assert.deepEqual(await next, { depth: 0, lines: [] });
});

test('movetext numbers from the start position and honours the plies limit', () => {
  const history = play('e4', 'e5', 'Nf3', 'Nc6').history({ verbose: true });
  assert.equal(movetext(history), '1. e4 e5 2. Nf3 Nc6');
  assert.equal(movetext(history, 3), '1... e5 2. Nf3 Nc6');
  assert.equal(movetext(history, 1), '2... Nc6');
  assert.equal(movetext([]), '');
});

test('movetext numbers from a custom start with Black to move', () => {
  const chess = new Chess('8/8/8/8/8/5k2/8/K6R b - - 0 40');
  for (const m of ['Ke3', 'Rh3+', 'Kd2']) chess.move(m);
  const history = chess.history({ verbose: true });
  assert.equal(movetext(history), '40... Ke3 41. Rh3+ Kd2');
  assert.equal(movetext(history, 2), '41. Rh3+ Kd2');
});

test('illegalPositionReason flags a check on the side not to move', () => {
  assert.equal(illegalPositionReason(new Chess()), null);
  assert.equal(illegalPositionReason(new Chess('4k3/8/8/8/4R3/8/8/4K3 b - - 0 1')), null);
  assert.equal(illegalPositionReason(new Chess('4k3/8/8/8/8/8/4R3/4K3 w - - 0 1')), 'the side not to move is in check');
  assert.equal(illegalPositionReason(new Chess('4k3/4r3/8/8/8/8/8/4K3 b - - 0 1')), 'the side not to move is in check');
});

test("UCI client does not hand a timed-out search's late bestmove to the next search", async () => {
  const uci = uciClient(() => {}, 20);
  await assert.rejects(uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 1, multipv: 1 }), /did not answer in time/);
  const next = uci.analyse('8/8/8/8/8/5k2/8/K6R w - - 0 1', { movetime: 1000, multipv: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  uci.feed('bestmove h1h2');
  uci.feed('info depth 9 multipv 1 score cp 700 pv h1h3');
  uci.feed('bestmove h1h3');
  assert.deepEqual(await next, { depth: 9, lines: [{ move: 'h1h3', cp: 700, mate: null }] });
});
