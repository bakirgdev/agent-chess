import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { buildRequest } from '../jev.js';
import { parsePlayer, publicEngine } from '../claude.js';

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
