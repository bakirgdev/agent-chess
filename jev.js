// Jev is a decision model, not a text generator: each turn it picks one option from the legal
// moves (a "choice" question). It does not search ahead, so every option carries precomputed
// facts (captures, safety, checks, mate threats) that it would otherwise have to calculate.
// Docs: https://docs.typesafe.ai/api/system-one.md, https://docs.typesafe.ai/primitives/choice.md

import { httpError } from './errors.js';
import { SIDES, movetext } from './public/chessutil.js';

const API_URL = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = process.env.JEV_MODEL ?? 'jev-latest';
const API_KEY = process.env.TYPESAFE_API_KEY;
// $42 per billion input tokens, output tokens are free (https://docs.typesafe.ai/models.md).
const USD_PER_INPUT_TOKEN = 42 / 1e9;

const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const other = (color) => (color === 'w' ? 'b' : 'w');

const attackerNames = (chess, square, color) =>
  chess.attackers(square, color).map((sq) => NAMES[chess.get(sq).type]);

function pieceSafety(chess, square, owner) {
  const attackers = attackerNames(chess, square, other(owner));
  if (!attackers.length) return null;
  const defenders = attackerNames(chess, square, owner);
  return `attacked by ${attackers.join(', ')}; ${defenders.length ? `defended by ${defenders.join(', ')}` : 'not defended'}`;
}

function threats(chess, owner) {
  return chess
    .board()
    .flat()
    .filter((p) => p && p.color === owner && p.type !== 'k')
    .flatMap((p) => {
      const safety = pieceSafety(chess, p.square, owner);
      return safety ? [`${NAMES[p.type]} on ${p.square}: ${safety}`] : [];
    });
}

function materialSummary(chess, us) {
  let diff = 0;
  for (const p of chess.board().flat()) if (p) diff += p.color === us ? VALUES[p.type] : -VALUES[p.type];
  if (diff === 0) return 'material is equal';
  return diff > 0 ? `you are ahead in material by ${diff} pawn(s) worth` : `you are behind in material by ${-diff} pawn(s) worth`;
}

const recentMoves = (chess, plies = 12) => movetext(chess.history({ verbose: true }), plies);

// Rough static exchange: what the owner can expect to lose on `square` if the opponent captures there.
function exchangeLoss(chess, square, owner) {
  const attackers = chess.attackers(square, other(owner)).map((sq) => chess.get(sq).type);
  if (!attackers.length) return 0;
  const value = VALUES[chess.get(square).type];
  if (!chess.attackers(square, owner).length) return value;
  // A king cannot capture onto a defended square.
  const cheapest = Math.min(...attackers.map((t) => (t === 'k' ? Infinity : VALUES[t])));
  return Math.max(0, value - cheapest);
}

const positionKey = (fen) => fen.split(' ').slice(0, 4).join(' ');

const MINOR_HOME = new Set(['b1', 'c1', 'f1', 'g1', 'b8', 'c8', 'f8', 'g8']);

// Opponent pieces the piece on `square` attacks, e.g. ["queen on d8"].
function attackedBy(chess, square, owner) {
  return chess
    .board()
    .flat()
    .filter((p) => p && p.color === other(owner) && chess.attackers(p.square, owner).includes(square))
    .map((p) => `${NAMES[p.type]} on ${p.square}`);
}

// Plays the move on the live game (so repetition history counts), reads the facts, then undoes it.
function describeMove(chess, move, seenPositions) {
  const us = move.color;
  const facts = { move: `${NAMES[move.piece]} from ${move.from} to ${move.to}` };
  if (move.captured) facts.captures = NAMES[move.captured];
  if (move.promotion) facts.promotes_to = NAMES[move.promotion];
  if (move.isKingsideCastle()) facts.castles = 'kingside';
  if (move.isQueensideCastle()) facts.castles = 'queenside';
  if ((move.piece === 'n' || move.piece === 'b') && MINOR_HOME.has(move.from)) facts.develops_piece = true;
  const gain = (move.captured ? VALUES[move.captured] : 0) + (move.promotion ? VALUES[move.promotion] - 1 : 0);

  chess.move(move.san);
  try {
    if (chess.isCheckmate()) facts.result = 'checkmate: you win the game';
    else if (chess.isDraw()) facts.result = 'the game ends in a draw';
    else {
      if (chess.inCheck()) facts.gives_check = true;
      let net = gain;
      if (move.piece !== 'k') {
        facts.moved_piece_after_move = pieceSafety(chess, move.to, us) ?? 'safe, not attacked';
        net -= exchangeLoss(chess, move.to, us);
      }
      const targets = attackedBy(chess, move.to, us);
      if (targets.length) facts.moved_piece_attacks = targets;
      if (net > 0) facts.likely_material_result = `wins about ${net} pawn(s) worth`;
      if (net < 0) facts.likely_material_result = `loses about ${-net} pawn(s) worth`;
      if (seenPositions.has(positionKey(chess.fen()))) facts.repeats_earlier_position = true;
      if (chess.moves().some((reply) => reply.endsWith('#'))) facts.danger = 'allows the opponent to checkmate you next move';
    }
  } finally {
    chess.undo();
  }
  return facts;
}

function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function buildRequest(chess) {
  const us = chess.turn();
  const side = SIDES[us];
  const seenPositions = new Set(chess.history({ verbose: true }).map((m) => positionKey(m.before)));
  // Jev leans toward the first option, so the order is randomized every turn.
  const criteria = Object.fromEntries(
    shuffle(chess.moves({ verbose: true })).map((m) => [m.san, describeMove(chess, m, seenPositions)]),
  );
  const state = {
    game: 'standard chess',
    you_play: side,
    move_number: chess.moveNumber(),
    position_fen: chess.fen(),
    you_are_in_check: chess.inCheck(),
    material: materialSummary(chess, us),
    your_pieces_under_attack: threats(chess, us),
    opponent_pieces_under_attack: threats(chess, other(us)),
    recent_moves: recentMoves(chess) || 'none, this is the first move',
  };
  const instructions =
    `You are a strong chess player playing ${side}. Choose the best move for ${side}. ` +
    'Every option is a legal move with verified facts about what it does. ' +
    'A move whose result is checkmate wins the game: always choose it. ' +
    'Never choose a move that allows the opponent to checkmate you. ' +
    'Prefer moves that win material, rescue your attacked pieces, or attack safely. ' +
    'Never choose a move that loses material unless it gives checkmate. ' +
    'When you are ahead in material, avoid moves that repeat an earlier position, because repetition draws the game. ' +
    'In the opening, develop a new knight or bishop instead of moving the same piece again, control the center, and castle early.';
  return { model: MODEL, state, questions: { move: { type: 'choice', instructions, criteria } } };
}

async function post(body) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw httpError(502, `Jev API unreachable: ${err.message}`);
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw httpError(502, `Jev API returned invalid JSON: ${text.slice(0, 200)}`);
      }
    }
    if ((res.status === 429 || res.status === 529) && attempt < 3) {
      // retry-after may also be an HTTP date; fall back to a linear backoff then. Capped because every
      // other move waits in the queue behind this one.
      const seconds = Math.min(Number(res.headers.get('retry-after')) || attempt, 10);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      continue;
    }
    throw httpError(502, `Jev API ${res.status}: ${text.slice(0, 300)}`);
  }
}

// Returns { san, confidence, candidates: [{ san, p }], model, costUsd } for the side to move.
export async function chooseMove(chess) {
  if (!API_KEY) throw httpError(500, 'TYPESAFE_API_KEY is not set (put it in .env)');
  const body = buildRequest(chess);
  const data = await post(body);
  const inputTokens = data.usage?.input_tokens ?? 0;
  const costUsd = inputTokens * USD_PER_INPUT_TOKEN;

  const answer = data.answers?.move;
  // Model output is untrusted: only accept a move that is one of the options we sent.
  if (typeof answer?.choice !== 'string' || !Object.hasOwn(body.questions.move.criteria, answer.choice)) {
    throw httpError(502, `Jev returned an unusable answer: ${JSON.stringify(answer)?.slice(0, 200)}`, { costUsd });
  }
  const candidates = Object.entries(answer.probabilities ?? {})
    .map(([san, p]) => ({ san, p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, 5);
  console.log(
    `${SIDES[chess.turn()]} ${chess.moveNumber()}. ${answer.choice}  conf=${answer.confidence?.toFixed(2)}  ` +
      `tokens=${inputTokens}  cost=$${costUsd.toFixed(5)}`,
  );
  return { san: answer.choice, confidence: answer.confidence ?? null, candidates, model: data.model ?? MODEL, costUsd };
}
