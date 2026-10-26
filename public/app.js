import { Chess, DEFAULT_POSITION, validateFen } from '/vendor/chess.js';
import * as sound from '/sound.js';
import { uciClient } from '/uci.js';
import { SIDES, illegalPositionReason } from '/chessutil.js';

const $ = (id) => document.getElementById(id);
const FILES = 'abcdefgh';
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ORDER = ['p', 'n', 'b', 'r', 'q'];
const NAMES = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };
const other = (color) => (color === 'w' ? 'b' : 'w');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const el = {
  board: $('board'), result: $('result'), banner: $('banner'), bannerText: $('banner-text'),
  status: $('status'), moves: $('moves'), think: $('think-body'), stats: $('stats'),
  primary: $('btn-primary'), delay: $('delay'), pgn: $('btn-pgn'),
  loadDialog: $('load-dialog'), loadText: $('load-text'), loadError: $('load-error'),
};

// Human moves never reach the server; the next engine request carries them in the history.
const HUMAN = { id: 'human', label: 'Human', anthropic: false, human: true, model: 'you' };
const FALLBACK_CONFIG = {
  engines: [{ id: 'jev', label: 'Jev', anthropic: false, model: 'jev-latest' }, HUMAN],
  effortsWithoutThinking: ['low', 'medium', 'high'],
  budgetTokensOptions: [1024, 4096, 16384, 32768],
  budgetUsd: null, spentUsd: 0, stockfish: false,
};
const STORE_KEY = 'agent-chess.players.v1';
let config = FALLBACK_CONFIG;
let players = { w: null, b: null };
const sideModel = { w: null, b: null }; // last model id reported per side, with the engine that reported it

let chess, state, flipped = false, gen = 0, loopGen = null, controller = null;
let spent = 0;
// `plies` caches chess.history({ verbose: true }), which chess.js rebuilds by replaying the whole game.
let plies, moveLog, totals, thinkingSince, tick, lastThink, lastResult;
let squareEls = new Map();
let pieceEls = new Map();
let piecesLayer;
let startFen = DEFAULT_POSITION;
let viewPly = null; // plies shown while browsing the move list; null = live position
let humanWait = null; // { resolve } while the side to move is a human
let selected = null, drag = null, cancelPromo = null, refocusSan = false;

// `game` is a fresh Chess, or one loaded from a FEN/PGN; the game continues from its last position.
function resetGame(game = new Chess()) {
  gen++;
  // The server still finishes and bills an aborted move; the next move's response carries the updated spend.
  if (controller) controller.abort();
  controller = null;
  // Resolving a pending human move lets the old game's loop see the new generation and exit.
  humanWait?.resolve(null);
  cancelPromo?.();
  stopClock();
  chess = game;
  plies = chess.history({ verbose: true });
  startFen = chess.getHeaders().FEN ?? DEFAULT_POSITION;
  viewPly = null;
  selected = null;
  state = 'idle';
  moveLog = plies.map((m) => ({ san: m.san, conf: null, model: 'imported' }));
  totals = { w: 0, b: 0, ms: 0 };
  lastThink = null;
  lastResult = gameOutcome() ?? recordedResult();
  el.result.hidden = true;
  hideBanner();
  buildBoard();
  if (lastResult) { state = 'over'; showResult(lastResult); }
  restartAnalysis();
  renderAll();
}

/* ---------- board ---------- */
function xy(sq) {
  const f = FILES.indexOf(sq[0]);
  const r = Number(sq[1]);
  return flipped ? [7 - f, r - 1] : [f, 8 - r];
}
function place(node, sq) {
  const [x, y] = xy(sq);
  node.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
}
function makePiece(color, type, sq) {
  const n = document.createElement('div');
  n.className = `piece ${color}${type}`;
  place(n, sq);
  piecesLayer.appendChild(n);
  pieceEls.set(sq, n);
}
// Earlier positions are rebuilt from the FEN after that ply, so they carry no move history.
const positionAt = (ply) => (ply === plies.length ? chess : new Chess(ply ? plies[ply - 1].after : startFen));
const shown = () => (viewPly === null ? chess : positionAt(viewPly));
function buildBoard() {
  const pos = shown();
  drag = null;
  el.board.replaceChildren();
  squareEls = new Map();
  pieceEls = new Map();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const f = flipped ? 7 - col : col;
      const r = flipped ? row + 1 : 8 - row;
      const sq = FILES[f] + r;
      const d = document.createElement('div');
      d.className = 'sq ' + ((f + r) % 2 === 0 ? 'd' : 'l');
      if (col === 0) d.insertAdjacentHTML('beforeend', `<span class="rk">${r}</span>`);
      if (row === 7) d.insertAdjacentHTML('beforeend', `<span class="fl">${FILES[f]}</span>`);
      squareEls.set(sq, d);
      el.board.appendChild(d);
    }
  }
  piecesLayer = document.createElement('div');
  piecesLayer.className = 'pieces';
  el.board.appendChild(piecesLayer);
  for (const rank of pos.board()) for (const p of rank) if (p) makePiece(p.color, p.type, p.square);
  updateHighlights(pos);
  renderSelection();
}
function updateHighlights(pos = shown()) {
  for (const d of squareEls.values()) d.classList.remove('hl', 'check');
  for (const b of el.board.querySelectorAll('.badge')) b.remove();
  const ply = viewPly ?? plies.length, last = plies[ply - 1];
  if (last) { squareEls.get(last.from).classList.add('hl'); squareEls.get(last.to).classList.add('hl'); }
  const g = last && grade(ply - 1);
  if (g) {
    const badge = document.createElement('span');
    badge.className = `badge g-${g.kind}`;
    badge.textContent = GRADES[g.kind][0];
    badge.title = GRADES[g.kind][1];
    squareEls.get(last.to).append(badge);
  }
  if (pos.inCheck()) {
    for (const rank of pos.board()) for (const p of rank) {
      if (p && p.type === 'k' && p.color === pos.turn()) squareEls.get(p.square).classList.add('check');
    }
  }
}
function animateMove(m) {
  const mover = pieceEls.get(m.from);
  const rank = m.from[1];
  const victimSq = m.isEnPassant() ? m.to[0] + rank : m.to;
  const victim = m.captured ? pieceEls.get(victimSq) : null;
  if (victim) {
    pieceEls.delete(victimSq);
    victim.classList.add('gone');
    setTimeout(() => victim.remove(), 250);
  }
  for (const n of piecesLayer.querySelectorAll('.top')) n.classList.remove('top');
  if (mover) {
    pieceEls.delete(m.from);
    mover.classList.add('top');
    place(mover, m.to);
    pieceEls.set(m.to, mover);
    if (m.isPromotion()) mover.className = `piece ${m.color}${m.promotion} top`;
  }
  if (m.isKingsideCastle() || m.isQueensideCastle()) {
    const k = m.isKingsideCastle();
    const rf = (k ? 'h' : 'a') + rank, rt = (k ? 'f' : 'd') + rank;
    const rook = pieceEls.get(rf);
    if (rook) { pieceEls.delete(rf); place(rook, rt); pieceEls.set(rt, rook); }
  }
  updateHighlights();
}

/* ---------- human moves ---------- */
const canMove = () => humanWait !== null && viewPly === null;
const movesFrom = (sq) => chess.moves({ square: sq, verbose: true });
function renderSelection() {
  for (const d of squareEls.values()) d.classList.remove('sel', 'tgt', 'cap');
  if (!selected) return;
  squareEls.get(selected).classList.add('sel');
  for (const m of movesFrom(selected)) squareEls.get(m.to).classList.add(m.captured ? 'cap' : 'tgt');
}
function select(sq) { selected = sq; renderSelection(); }
function squareAt(ev) {
  const r = el.board.getBoundingClientRect();
  const col = Math.floor(((ev.clientX - r.left) / r.width) * 8), row = Math.floor(((ev.clientY - r.top) / r.height) * 8);
  if (col < 0 || col > 7 || row < 0 || row > 7) return null;
  return FILES[flipped ? 7 - col : col] + (flipped ? row + 1 : 8 - row);
}
function choosePromotion(color) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'promo';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Promote to');
    const done = (type) => { cancelPromo = null; box.remove(); resolve(type); };
    for (const t of ['q', 'r', 'b', 'n']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `piece ${color}${t}`;
      b.setAttribute('aria-label', NAMES[t]);
      b.addEventListener('click', () => done(t));
      box.append(b);
    }
    box.addEventListener('pointerdown', (ev) => { if (ev.target === box) done(null); });
    cancelPromo = () => done(null);
    el.board.parentElement.append(box);
    box.querySelector('button').focus();
  });
}
async function tryMove(from, to) {
  const options = movesFrom(from).filter((m) => m.to === to);
  if (!options.length) return;
  let move = options[0];
  if (options.length > 1) {
    const node = pieceEls.get(from);
    if (node) place(node, to);
    const type = await choosePromotion(chess.turn());
    move = options.find((m) => m.promotion === type);
  }
  select(null);
  if (!move || !canMove()) {
    const node = pieceEls.get(from);
    if (node) place(node, from);
    return;
  }
  humanWait.resolve(move.san);
}
el.board.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || !humanWait) return;
  if (viewPly !== null) { view(null); return; }
  const sq = squareAt(ev);
  if (!sq) return;
  if (selected && movesFrom(selected).some((m) => m.to === sq)) { tryMove(selected, sq); return; }
  const p = chess.get(sq);
  if (!p || p.color !== chess.turn()) { select(null); return; }
  const wasSelected = selected === sq;
  select(sq);
  const node = pieceEls.get(sq);
  if (!node) return;
  drag = { node, from: sq, x: ev.clientX, y: ev.clientY, moved: false, wasSelected };
  el.board.setPointerCapture(ev.pointerId);
});
el.board.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(ev.clientX - drag.x, ev.clientY - drag.y) < 4) return;
  drag.moved = true;
  drag.node.classList.add('dragging');
  const r = el.board.getBoundingClientRect(), half = r.width / 16;
  drag.node.style.transform = `translate(${ev.clientX - r.left - half}px, ${ev.clientY - r.top - half}px)`;
});
function endDrag(ev, dropped) {
  if (!drag) return;
  const { node, from, moved, wasSelected } = drag;
  drag = null;
  node.classList.remove('dragging');
  // A click on the already selected piece deselects it, as on chess.com.
  if (!moved) { if (wasSelected) select(null); return; }
  const sq = dropped ? squareAt(ev) : null;
  if (sq && sq !== from && movesFrom(from).some((m) => m.to === sq)) tryMove(from, sq);
  else place(node, from);
}
el.board.addEventListener('pointerup', (ev) => endDrag(ev, true));
el.board.addEventListener('pointercancel', (ev) => endDrag(ev, false));

/* ---------- move list browsing ---------- */
function view(ply) {
  const n = plies.length;
  const next = ply === null || ply >= n || n === 0 ? null : Math.max(0, ply);
  if (next === viewPly) return;
  cancelPromo?.();
  viewPly = next;
  selected = null;
  buildBoard();
  renderEvalBar();
  renderMoves();
  renderStatus();
  renderControls();
}

/* ---------- analysis: eval bar and move grades ---------- */
// 'off', 'browser' (Stockfish lite WASM in a worker) or 'native' (the server's Stockfish, e.g. `brew install stockfish`).
const ANALYSIS_KEY = 'agent-chess.analysis.v1';
const BROWSER_MOVETIME_MS = 400;
const GRADES = {
  forced: ['\u25A1', 'Forced'], great: ['!', 'Great move'], best: ['\u2605', 'Best move'], excellent: ['\u2713', 'Excellent'],
  good: ['\u2713', 'Good'], inaccuracy: ['?!', 'Inaccuracy'], mistake: ['?', 'Mistake'], blunder: ['??', 'Blunder'],
};
let analysisMode = 'off', evals = [], analysisGen = 0, analysing = false, worker = null, browserUci = null;
// The search in flight, even one from a previous game: a new game waits for it, so a tab never has more
// than one analysis request open (the server caps them).
let searching = Promise.resolve();

// Lichess's win-chance curve: a line's score (from the side to move) as 0..100, centipawns capped at ±1000.
function winChance({ cp, mate }) {
  if (mate != null) return mate > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1);
}
// Highest loss in win chance (percentage points) for each grade; lichess flags 5/10/15 as inaccuracy/mistake/blunder.
const LOSS_GRADES = [[2, 'excellent'], [5, 'good'], [10, 'inaccuracy'], [15, 'mistake'], [Infinity, 'blunder']];

function browserEngine() {
  if (!browserUci) {
    worker = new Worker('/vendor/stockfish/stockfish-19-lite-single.js');
    browserUci = uciClient((cmd) => worker.postMessage(cmd));
    worker.onmessage = (ev) => browserUci.feed(String(ev.data));
    // The worker's own error text is often just "Uncaught [object Object]".
    worker.onerror = () => browserUci.fail(new Error('the in-browser Stockfish crashed'));
    worker.postMessage('uci');
  }
  return browserUci;
}
function stopBrowserEngine() {
  worker?.terminate();
  browserUci?.fail(new Error('Analysis engine stopped'));
  worker = null;
  browserUci = null;
}
async function search(fen) {
  if (analysisMode === 'browser') return browserEngine().analyse(fen, { movetime: BROWSER_MOVETIME_MS, multipv: 2 });
  const res = await fetch('/api/eval', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fen }) });
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !Array.isArray(body?.lines)) throw new Error(body?.error || `Analysis failed (${res.status})`);
  return body;
}
// White's win chance and a label for one position, plus what grading the move played from it needs.
async function evaluate(pos) {
  const legal = pos.moves().length;
  if (pos.isCheckmate()) return pos.turn() === 'w' ? { wp: 0, label: '0-1', legal } : { wp: 100, label: '1-0', legal };
  if (pos.isDraw()) return { wp: 50, label: '\u00BD-\u00BD', legal };
  const [top, second] = (await search(pos.fen())).lines;
  if (!top) throw new Error('Stockfish returned no evaluation');
  const sign = pos.turn() === 'w' ? 1 : -1;
  const mover = winChance(top);
  const label = top.mate != null
    ? `${top.mate * sign > 0 ? '' : '-'}M${Math.abs(top.mate)}`
    : `${top.cp * sign >= 0 ? '+' : ''}${((top.cp * sign) / 100).toFixed(1)}`;
  return { wp: sign > 0 ? mover : 100 - mover, label, legal, best: top.move, gap: second ? mover - winChance(second) : 0 };
}
// Grade of ply i from the mover's loss in win chance, with lichess-style thresholds and chess.com names.
// "Great" is the engine's best move when the second-best move is much worse.
function grade(i) {
  const a = evals[i], b = evals[i + 1], m = plies[i];
  if (!a || !b || !m) return null;
  if (a.legal === 1) return { kind: 'forced', loss: 0 };
  if (m.lan === a.best) return { kind: a.gap >= 15 ? 'great' : 'best', loss: 0 };
  const loss = Math.max(0, m.color === 'w' ? a.wp - b.wp : b.wp - a.wp);
  return { kind: LOSS_GRADES.find(([max]) => loss <= max)[1], loss };
}
// Lichess's per-move accuracy formula, averaged per side (forced moves don't count).
function accuracy() {
  const per = { w: [], b: [] };
  plies.forEach((m, i) => {
    const g = grade(i);
    if (g && g.kind !== 'forced') per[m.color].push(Math.min(100, Math.max(0, 103.1668 * Math.exp(-0.04354 * g.loss) - 3.1669)));
  });
  const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
  return { w: avg(per.w), b: avg(per.b) };
}
async function pumpAnalysis() {
  if (analysing || analysisMode === 'off') return;
  analysing = true;
  const myGen = analysisGen;
  try {
    await searching;
    for (;;) {
      if (myGen !== analysisGen) return;
      // The live position first, so the bar keeps up; then any earlier gaps (e.g. a loaded PGN).
      const n = plies.length;
      let ply = evals[n] ? -1 : n;
      for (let i = 0; ply < 0 && i < n; i++) if (!evals[i]) ply = i;
      if (ply < 0) break;
      const job = evaluate(positionAt(ply));
      searching = job.catch(() => {});
      const result = await job;
      if (myGen !== analysisGen) return;
      evals[ply] = result;
      renderAnalysis();
    }
  } catch (err) {
    if (myGen !== analysisGen) return;
    showBanner(`Analysis stopped: ${err.message}`);
    setAnalysisMode('off', { save: false });
  } finally {
    if (myGen === analysisGen) analysing = false;
  }
}
function restartAnalysis() {
  analysisGen++;
  analysing = false;
  evals = [];
  pumpAnalysis();
}
function setAnalysisMode(mode, { save = true } = {}) {
  if (mode !== 'browser') stopBrowserEngine();
  analysisMode = mode;
  $('analysis').value = mode;
  if (save) {
    try { localStorage.setItem(ANALYSIS_KEY, mode); } catch { /* storage unavailable: setting lasts for this page only */ }
  }
  restartAnalysis();
  renderAnalysis();
}
function initAnalysis() {
  const native = $('analysis').querySelector('option[value="native"]');
  native.disabled = !config.stockfish;
  $('analysis').title = config.stockfish
    ? 'Browser: Stockfish lite in this tab. Native: the Stockfish installed on this machine.'
    : 'Browser: Stockfish lite in this tab. Native needs: brew install stockfish';
  let saved = null;
  try { saved = localStorage.getItem(ANALYSIS_KEY); } catch { /* storage unavailable: use the default */ }
  const usable = saved === 'off' || saved === 'browser' || (saved === 'native' && config.stockfish);
  setAnalysisMode(usable ? saved : config.stockfish ? 'native' : 'browser', { save: false });
}
function renderEvalBar() {
  const bar = $('evalbar');
  bar.hidden = analysisMode === 'off';
  if (bar.hidden) return;
  // Until the shown position is evaluated, keep showing the last known one instead of jumping to even.
  let e = null;
  for (let k = viewPly ?? plies.length; k >= 0 && !e; k--) e = evals[k] ?? null;
  const wp = e ? e.wp : 50, whiteLeads = wp >= 50;
  bar.classList.toggle('flipped', flipped);
  bar.querySelector('.evalfill').style.height = `${wp}%`;
  const label = bar.querySelector('.evallabel');
  label.textContent = e ? e.label.replace(/^[+-]/, '') : '';
  label.classList.toggle('on-white', whiteLeads);
  label.classList.toggle('at-top', whiteLeads === flipped);
  bar.setAttribute('aria-valuenow', String(Math.round(wp)));
  bar.setAttribute('aria-valuetext', e ? `Evaluation ${e.label}` : 'Evaluating');
}
function renderAnalysis() {
  document.documentElement.classList.toggle('with-eval', analysisMode !== 'off');
  renderEvalBar();
  renderMoves();
  renderStats();
  if (squareEls.size) updateHighlights();
}

/* ---------- config ---------- */
async function fetchConfig() {
  const c = await (await fetch('/api/config')).json();
  if (!c || !Array.isArray(c.engines) || !c.engines.length) throw new Error('Malformed /api/config');
  return c;
}

/* ---------- players ---------- */
const engineOf = (id) => config.engines.find((e) => e.id === id) || config.engines[0];
const modesOf = (e) => e.thinking ?? [];
const effortsOf = (e) => e.efforts ?? [];
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const fmtTok = (n) => `${Math.round(n / 1024)}K`;
const fmtPrice = (p) => `$${p[0]}/$${p[1]}`;
function allowedEfforts(e, thinking) {
  const all = effortsOf(e);
  return thinking === 'off' ? all.filter((f) => config.effortsWithoutThinking.includes(f)) : all;
}
function clampEffort(p) {
  const e = engineOf(p.engine), a = allowedEfforts(e, p.thinking);
  if (!effortsOf(e).length) p.effort = null;
  else if (a.length && !a.includes(p.effort)) p.effort = a.at(-1);
  return p;
}
// Unknown engine falls back to the first one's defaults; unsupported saved values fall back to that engine's defaults.
function normalizePlayer(raw) {
  const e = config.engines.find((x) => x.id === raw?.engine) ?? config.engines[0];
  const r = e.id === raw?.engine ? raw : {};
  const modes = modesOf(e), efforts = effortsOf(e), bo = config.budgetTokensOptions;
  const pick = (list, v, d) => (list.includes(v) ? v : d);
  return clampEffort({
    engine: e.id,
    thinking: pick(modes, r.thinking, pick(modes, e.defaultThinking, modes[0] ?? null)),
    effort: pick(efforts, r.effort, pick(efforts, e.defaultEffort, efforts[0] ?? null)),
    budget: pick(bo, r.budget, bo.includes(4096) ? 4096 : bo[0]),
    fast: e.fast === true && r.fast === true,
  });
}
function loadPlayers() {
  let raw = null;
  try { raw = JSON.parse(localStorage.getItem(STORE_KEY)); } catch { /* unavailable or corrupt: use defaults */ }
  players = { w: normalizePlayer(raw && raw.w), b: normalizePlayer(raw && raw.b) };
}
function savePlayers() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(players)); } catch { /* storage unavailable: settings last for this page only */ }
}
function modelFor(color) {
  const e = engineOf(players[color].engine), sm = sideModel[color];
  return sm && sm.engine === e.id ? sm.model : (e.model || e.id);
}
// Option summary shown after the model id, e.g. ['high', 'no thinking', 'fast']
function detailParts(color) {
  const p = players[color], e = engineOf(p.engine);
  if (!e.anthropic) return [];
  const parts = [];
  if (p.effort) parts.push(p.effort);
  if (p.thinking === 'off') parts.push('no thinking');
  else if (p.thinking === 'budget') parts.push(`budget ${fmtTok(p.budget)}`);
  if (p.fast) parts.push('fast');
  return parts;
}
const tagFor = (color) => [modelFor(color), ...detailParts(color)].join(' · ');
function playerDesc(color) {
  const e = engineOf(players[color].engine);
  return e.human ? e.label : `${e.label} (${[modelFor(color), ...detailParts(color)].join(', ')})`;
}
function renderTitle() {
  const t = `${engineOf(players.w.engine).label} vs ${engineOf(players.b.engine).label}`;
  $('title').textContent = t;
  document.title = `Agent Chess: ${t}`;
}
function renderPlayers() {
  for (const c of ['w', 'b']) {
    const p = players[c], e = engineOf(p.engine);
    const modes = modesOf(e), efforts = effortsOf(e);
    $(`eng-${c}`).value = e.id;
    $(`opts-${c}`).hidden = !e.anthropic;
    $(`fth-${c}`).hidden = modes.length < 2;
    $(`thst-${c}`).hidden = modes.length !== 1;
    if (modes.length === 1) $(`thst-${c}`).textContent = modes[0] === 'off' ? 'Thinking: off' : 'Thinking: always on';
    $(`fbud-${c}`).hidden = p.thinking !== 'budget';
    $(`bud-${c}`).value = String(p.budget);
    $(`feff-${c}`).hidden = !efforts.length;
    if (efforts.length) {
      const ok = allowedEfforts(e, p.thinking), sel = $(`eff-${c}`);
      sel.replaceChildren(...efforts.map((f) => { const o = new Option(cap(f), f); o.disabled = !ok.includes(f); return o; }));
      sel.value = p.effort;
    }
    $(`ffast-${c}`).hidden = !e.fast;
    $(`fast-${c}`).checked = p.fast;
    if (e.fast && e.fastPrice) $(`ffast-${c}`).title = `Fast mode: ${fmtPrice(e.fastPrice)} per million input/output tokens`;
    // Thinking select options depend on the engine
    if (modes.length > 1) {
      const sel = $(`think-${c}`);
      if ([...sel.options].map((o) => o.value).join() !== modes.join()) sel.replaceChildren(...modes.map((m) => new Option(cap(m), m)));
      sel.value = p.thinking;
    }
  }
  const note = $('pnote');
  note.hidden = !config.anthropicError;
  note.textContent = config.anthropicError ? `Anthropic models unavailable: ${config.anthropicError}` : '';
  renderTitle();
}
function initPlayers() {
  const mk = (e) => new Option(e.anthropic ? `${e.label} · ${fmtPrice(e.price)}` : e.label, e.id);
  for (const c of ['w', 'b']) {
    const sel = $(`eng-${c}`);
    const groups = [
      ['TypeSafe', config.engines.filter((e) => !e.anthropic && !e.human)],
      ['Anthropic', config.engines.filter((e) => e.anthropic)],
      ['Human', config.engines.filter((e) => e.human)],
    ];
    sel.replaceChildren(...groups.filter(([, l]) => l.length).map(([name, l]) => {
      const g = document.createElement('optgroup');
      g.label = name;
      g.append(...l.map(mk));
      return g;
    }));
    $(`bud-${c}`).replaceChildren(...config.budgetTokensOptions.map((n) => new Option(fmtTok(n), String(n))));
  }
  loadPlayers();
  renderPlayers();
}
function wirePlayers() {
  for (const c of ['w', 'b']) {
    $(`eng-${c}`).addEventListener('change', (ev) => {
      players[c] = normalizePlayer({ engine: ev.target.value });
      playersChanged();
    });
    $(`think-${c}`).addEventListener('change', (ev) => {
      players[c].thinking = ev.target.value;
      clampEffort(players[c]);
      playersChanged();
    });
    $(`bud-${c}`).addEventListener('change', (ev) => { players[c].budget = Number(ev.target.value); playersChanged(); });
    $(`eff-${c}`).addEventListener('change', (ev) => { players[c].effort = ev.target.value; playersChanged(); });
    $(`fast-${c}`).addEventListener('change', (ev) => { players[c].fast = ev.target.checked; playersChanged(); });
  }
}
function playersChanged() { savePlayers(); renderPlayers(); renderBars(); }

/* ---------- player bars ---------- */
function captured() {
  const caps = { w: [], b: [] }; // pieces captured BY that side
  for (const m of plies) if (m.captured) caps[m.color].push(m.captured);
  return caps;
}
// Counted from the board rather than the captures, so promotions and loaded positions are right too.
function material(color) {
  let sum = 0;
  for (const p of chess.board().flat()) if (p && p.color === color && p.type !== 'k') sum += VALUES[p.type];
  return sum;
}
function fmtClock(ms) {
  const t = Math.floor(ms / 100) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}
function renderBar(node, color, caps) {
  const mine = caps[color];
  const oppColor = other(color);
  const adv = material(color) - material(oppColor);
  const groups = ORDER.map((t) => {
    const n = mine.filter((x) => x === t).length;
    return n ? `<span class="cap-group">${`<span class="piece ${oppColor}${t}"></span>`.repeat(n)}</span>` : '';
  }).join('');
  const active = state !== 'idle' && state !== 'over' && chess.turn() === color;
  const clockMs = totals[color] + (active && thinkingSince ? performance.now() - thinkingSince : 0);
  node.className = `player-bar${active ? ' active' : ''}${active && thinkingSince ? ' thinking' : ''}`;
  const eng = engineOf(players[color].engine);
  node.innerHTML = `
    <div class="avatar ${color}" aria-hidden="true">${esc(monogram(eng))}</div>
    <div class="pinfo">
      <div class="pname">${esc(eng.label)} <span class="tag">${esc(tagFor(color))}</span><span class="dot"></span></div>
      <div class="captured" aria-label="Captured pieces">${groups}${adv > 0 ? `<span class="adv">+${adv}</span>` : ''}</div>
    </div>
    <div class="clock" role="timer" aria-label="${SIDES[color]} thinking time">${fmtClock(clockMs)}</div>`;
}
const monogram = (e) => { const w = e.label.split(' '); return (w[0] === 'Claude' && w[1] ? w[1] : w[0])[0].toUpperCase(); };

/* ---------- panels ---------- */
function renderMoves() {
  const rows = [];
  // A loaded position can start at any move number, with Black to move.
  const [, side, , , , fullmove] = startFen.split(' ');
  const offset = side === 'b' ? 1 : 0;
  // One tab stop for the whole list (the viewed or last move); arrow keys move between moves.
  const current = viewPly ?? moveLog.length;
  for (let i = 0; moveLog.length && i < moveLog.length + offset; i += 2) {
    const cell = (k) => {
      const j = k - offset, m = moveLog[j];
      if (!m) return '<span></span>';
      const tip = m.conf == null ? (m.model || 'unknown model') : `Confidence: ${Math.round(m.conf * 100)}%`;
      const viewing = viewPly === j + 1;
      const g = analysisMode === 'off' ? null : grade(j);
      const mark = g ? `<span class="grade g-${g.kind}" aria-hidden="true">${GRADES[g.kind][0]}</span><span class="sr"> (${GRADES[g.kind][1]})</span>` : '';
      const cls = `mv${j === moveLog.length - 1 ? ' last' : ''}${viewing ? ' viewing' : ''}`;
      const attrs = `${viewing ? ' aria-current="true"' : ''} tabindex="${j + 1 === current ? 0 : -1}"`;
      return `<button type="button" class="${cls}" data-ply="${j + 1}" title="${esc(tip)}"${attrs}>${esc(m.san)}${mark}</button>`;
    };
    rows.push(`<div class="mrow"><span class="mnum">${Number(fullmove) + i / 2}.</span>${cell(i)}${cell(i + 1)}</div>`);
  }
  if (lastResult) rows.push(`<div class="mres"><b>${lastResult.score}</b> &nbsp;${esc(lastResult.title)} (${esc(lastResult.reason)})</div>`);
  // The list is rebuilt on every render: keep keyboard focus on the current move, and only follow the
  // newest move if the reader hasn't scrolled away from it.
  const list = el.moves;
  const hadFocus = list.contains(document.activeElement);
  const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 8 || list.childElementCount !== rows.length;
  list.innerHTML = rows.join('');
  if (hadFocus) list.querySelector('[tabindex="0"]')?.focus({ preventScroll: true });
  const v = viewPly === null ? null : list.querySelector('.viewing');
  if (v) {
    // Scroll only the list (scrollIntoView would also scroll the page).
    const r = v.getBoundingClientRect(), box = list.getBoundingClientRect();
    if (r.top < box.top) list.scrollTop -= box.top - r.top;
    else if (r.bottom > box.bottom) list.scrollTop += r.bottom - box.bottom;
  } else if (viewPly === null && follow) {
    list.scrollTop = list.scrollHeight;
  }
}
function renderThink() {
  const title = lastThink ? `${lastThink.label}'s thinking` : 'Thinking';
  $('think-title').textContent = title;
  $('think').setAttribute('aria-label', title);
  if (!lastThink) { el.think.innerHTML = '<p class="muted">No decision yet.</p>'; return; }
  const { san, candidates, thinking } = lastThink;
  if (candidates.length) {
    const bars = candidates.map((c) => ({ san: c.san, pct: Math.max(0, Math.min(100, c.p * 100)) }));
    el.think.innerHTML = bars.map((c) => `<div class="cand${c.san === san ? ' pick' : ''}"><span class="san">${esc(c.san)}</span>
      <span class="track"><span class="fill"></span></span>
      <span class="pct">${c.pct < 10 ? c.pct.toFixed(1) : Math.round(c.pct)}%</span></div>`).join('');
    el.think.querySelectorAll('.fill').forEach((f, i) => { f.style.width = `${bars[i].pct}%`; });
  } else if (thinking) {
    el.think.innerHTML = `<div class="think-text" tabindex="0" role="region" aria-label="${esc(title)}">${esc(thinking)}</div>`;
  } else {
    el.think.innerHTML = '<p class="muted">No reasoning returned (thinking off)</p>';
  }
}
function renderStats() {
  const n = moveLog.length;
  const avg = n ? Math.round(totals.ms / n) : 0;
  let acc = '';
  if (analysisMode !== 'off') {
    const a = accuracy(), done = evals.filter(Boolean).length, total = plies.length + 1;
    if (a.w != null || a.b != null) acc = ` · Accuracy: White ${a.w ?? '-'}%, Black ${a.b ?? '-'}%`;
    if (done < total) acc += ` · Analysing ${done}/${total}`;
  }
  el.stats.textContent = `Moves: ${n} · Spent: $${spent.toFixed(4)}${config.budgetUsd == null ? '' : ` of $${Number(config.budgetUsd).toFixed(4)}`} · Avg: ${avg} ms/move${acc}`;
}
function renderStatus() {
  const s = el.status;
  if (state === 'idle') s.textContent = 'Press Start to begin';
  else if (state === 'over') s.textContent = lastResult ? `${lastResult.title} · ${lastResult.reason}` : 'Game over';
  else if (thinkingSince && state === 'paused') s.textContent = `Pausing after ${SIDES[chess.turn()]}'s move\u2026`;
  else if (humanWait) s.textContent = `Your move (${SIDES[chess.turn()]})`;
  else if (thinkingSince) s.textContent = `${SIDES[chess.turn()]} is thinking\u2026`;
  else if (state === 'paused') s.textContent = 'Paused';
  else s.textContent = `${SIDES[chess.turn()]} to move`;
  if (viewPly !== null) s.textContent += ` \u00b7 viewing move ${viewPly} (End for live)`;
}
function renderControls() {
  el.primary.textContent = { running: 'Pause', paused: 'Resume' }[state] ?? 'Start';
  el.primary.disabled = state === 'over';
  el.primary.setAttribute('aria-label', `${el.primary.textContent} game`);
  const turn = state === 'over' ? 'Game over.' : `${SIDES[chess.turn()]} to move.`;
  el.board.setAttribute('aria-label', `Chess board. ${turn}`);
  // A reply is reported against the side's current engine, so settings can't change while a move is in flight.
  for (const n of document.querySelectorAll('.players select, .players input')) n.disabled = thinkingSince != null;
  el.board.classList.toggle('interactive', canMove());
  const sanForm = $('san-form');
  sanForm.hidden = !canMove();
  if (!sanForm.hidden && refocusSan) { refocusSan = false; $('san-input').focus(); }
}
function renderBars() {
  const caps = captured();
  renderBar($('bar-top'), flipped ? 'w' : 'b', caps);
  renderBar($('bar-bottom'), flipped ? 'b' : 'w', caps);
}
function renderAll() { renderBars(); renderEvalBar(); renderMoves(); renderThink(); renderStats(); renderStatus(); renderControls(); }

/* ---------- game flow ---------- */
function showBanner(msg) { el.bannerText.textContent = msg; el.banner.hidden = false; }
function hideBanner() { el.banner.hidden = true; }

function gameOutcome() {
  if (chess.isCheckmate()) {
    const winner = other(chess.turn());
    return { title: `${SIDES[winner]} Won`, reason: 'by checkmate', score: winner === 'w' ? '1-0' : '0-1' };
  }
  const draw = (reason) => ({ title: 'Draw', reason, score: '½-½' });
  if (chess.isStalemate()) return draw('by stalemate');
  if (chess.isThreefoldRepetition()) return draw('by threefold repetition');
  if (chess.isInsufficientMaterial()) return draw('by insufficient material');
  if (chess.isDrawByFiftyMoves()) return draw('by the 50-move rule');
  return null;
}
// A loaded PGN can end by resignation or agreement, which the position alone doesn't show.
function recordedResult() {
  const score = { '1-0': '1-0', '0-1': '0-1', '1/2-1/2': '\u00BD-\u00BD' }[chess.getHeaders().Result];
  if (!score || !plies.length) return null;
  const title = score === '1-0' ? 'White Won' : score === '0-1' ? 'Black Won' : 'Draw';
  return { title, reason: 'as recorded in the PGN', score };
}
function showResult(o) {
  $('result-title').textContent = o.title;
  $('result-reason').textContent = o.reason;
  $('result-score').textContent = o.score;
  el.result.hidden = false;
  $('result-new').focus({ preventScroll: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function stopClock() {
  thinkingSince = null;
  clearInterval(tick);
}

function startClockTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    const clock = document.querySelector('.player-bar.active .clock');
    if (clock && thinkingSince) clock.textContent = fmtClock(totals[chess.turn()] + performance.now() - thinkingSince);
  }, 100);
}

async function requestMove(color, signal) {
  const p = players[color], isAnth = engineOf(p.engine).anthropic;
  const player = isAnth
    ? { engine: p.engine, thinking: p.thinking, effort: p.effort, budgetTokens: p.thinking === 'budget' ? p.budget : null, fast: p.fast }
    : { engine: p.engine, effort: null, budgetTokens: null, fast: false };
  const res = await fetch('/api/move', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fen: startFen, moves: plies.map((m) => m.san), player }), signal,
  });
  let body = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) throw new Error((body && body.error) || `Request failed (${res.status})`);
  if (!body || typeof body.san !== 'string') throw new Error('Malformed response from server');
  return body;
}

async function loop() {
  const myGen = gen;
  if (loopGen === myGen) return;
  loopGen = myGen;
  let mine = null;
  try {
    while (state === 'running' && gen === myGen) {
      const color = chess.turn();
      const eng = engineOf(players[color].engine);
      thinkingSince = performance.now();
      startClockTick();
      const human = eng.human
        ? new Promise((resolve) => { humanWait = { resolve: (san) => { humanWait = null; resolve(san); } }; })
        : null;
      renderAll();
      let r;
      if (human) {
        const san = await human;
        if (gen !== myGen) return;
        if (!san) {
          // Paused on the human's turn: keep the time spent so far on their clock.
          totals[color] += performance.now() - thinkingSince;
          stopClock();
          return;
        }
        r = { san, ms: Math.round(performance.now() - thinkingSince), model: HUMAN.model };
      } else {
        mine = controller = new AbortController();
        try {
          r = await requestMove(color, mine.signal);
        } catch (e) {
          if (gen !== myGen || e.name === 'AbortError') return;
          stopClock();
          state = 'paused';
          showBanner(e.message || 'Network error');
          renderAll();
          return;
        }
        if (gen !== myGen) return;
      }
      stopClock();
      let m;
      try {
        m = chess.move(r.san);
        plies.push(m);
      } catch {
        state = 'paused';
        showBanner(`${eng.label} returned an illegal move: ${r.san}`);
        renderAll();
        return;
      }
      const ms = Number.isFinite(r.ms) ? r.ms : 0;
      totals[color] += ms;
      totals.ms += ms;
      if (typeof r.model === 'string' && r.model) sideModel[color] = { engine: eng.id, model: r.model };
      if (Number.isFinite(r.spentUsd)) spent = r.spentUsd;
      moveLog.push({ san: m.san, conf: Number.isFinite(r.confidence) ? r.confidence : null, model: modelFor(color) });
      if (!eng.human) {
        lastThink = {
          san: m.san, label: eng.label,
          candidates: Array.isArray(r.candidates) ? r.candidates : [],
          thinking: typeof r.thinking === 'string' && r.thinking.trim() ? r.thinking : null,
        };
      }
      // While browsing old moves the board stays put; End or a click on the last move catches up.
      if (viewPly === null) animateMove(m);
      const out = gameOutcome();
      sound.play(soundFor(m, out));
      pumpAnalysis();
      if (out) {
        state = 'over';
        lastResult = out;
        showResult(out);
        renderAll();
        return;
      }
      renderAll();
      if (state !== 'running') break;
      // The delay is for watching engines; it never holds up a human or an engine replying to one.
      const d = Number(el.delay.value);
      if (d && !eng.human && !engineOf(players[chess.turn()].engine).human) await sleep(d);
    }
  } finally {
    if (loopGen === myGen) loopGen = null;
    if (controller === mine) controller = null;
    if (gen === myGen && state === 'paused') renderAll();
  }
}

function soundFor(m, outcome) {
  if (outcome) return 'end';
  if (chess.inCheck()) return 'check';
  if (m.isCapture()) return 'capture';
  return m.isKingsideCastle() || m.isQueensideCastle() ? 'castle' : 'move';
}

function onPrimary() {
  // Browsers only start audio from a user gesture, so engine-only games need it created here.
  sound.unlock();
  if (state === 'idle' || state === 'paused') {
    hideBanner();
    state = 'running';
    renderAll();
    loop();
  } else if (state === 'running') {
    state = 'paused';
    cancelPromo?.();
    humanWait?.resolve(null);
    renderAll();
  }
}

function buildPgn() {
  const d = new Date();
  const date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const result = lastResult ? lastResult.score.replace('½-½', '1/2-1/2') : '*';
  // Headers live on the game object only until the next reset; nothing else reads them.
  chess.setHeader('Event', 'Agent Chess');
  chess.setHeader('Site', 'https://github.com/bakirgdev/agent-chess');
  chess.setHeader('Date', date);
  chess.setHeader('White', playerDesc('w'));
  chess.setHeader('Black', playerDesc('b'));
  chess.setHeader('Result', result);
  return chess.pgn();
}
const PGN_LABEL = 'Copy PGN';
let pgnTimer;
async function copyPgn() {
  const text = buildPgn();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { showBanner('Could not copy PGN to the clipboard'); return; }
  }
  el.pgn.textContent = 'Copied!';
  clearTimeout(pgnTimer);
  pgnTimer = setTimeout(() => { el.pgn.textContent = PGN_LABEL; }, 1200);
}

/* ---------- wiring ---------- */
el.primary.addEventListener('click', onPrimary);
$('btn-new').addEventListener('click', () => resetGame());
$('result-new').addEventListener('click', () => resetGame());
$('btn-flip').addEventListener('click', () => {
  cancelPromo?.();
  flipped = !flipped;
  buildBoard();
  renderBars();
  renderEvalBar();
});
$('analysis').addEventListener('change', (ev) => setAnalysisMode(ev.target.value));
el.pgn.addEventListener('click', copyPgn);
el.moves.addEventListener('click', (ev) => {
  const b = ev.target.closest('.mv');
  if (b) view(Number(b.dataset.ply));
});
$('sound').checked = !sound.isMuted();
$('sound').addEventListener('change', (ev) => sound.setMuted(!ev.target.checked));

// Keyboard alternative to the board: SAN (Nf3, exd5, e8=Q) or coordinates (g1f3, e7e8q).
$('san-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = $('san-input');
  const text = input.value.trim();
  const bare = (san) => san.replace(/[+#!?]/g, '');
  const move = chess.moves({ verbose: true }).find((m) => bare(m.san) === bare(text) || m.lan === text.toLowerCase());
  const coords = /^([a-h][1-8])([a-h][1-8])$/.exec(text.toLowerCase());
  if (!move && coords && canMove() && movesFrom(coords[1]).some((m) => m.to === coords[2])) {
    // e7e8 without a piece letter: ask which piece, like a promotion on the board.
    input.value = '';
    tryMove(coords[1], coords[2]);
    return;
  }
  if (!move || !canMove()) {
    input.setCustomValidity(move ? 'Not your turn' : `${text || 'That'} is not a legal move here`);
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  input.value = '';
  refocusSan = true;
  select(null);
  humanWait.resolve(move.san);
});
$('san-input').addEventListener('input', (ev) => ev.target.setCustomValidity(''));

function parseGame(text) {
  if (!text) throw new Error('Paste a FEN or a PGN first');
  // Some sites copy FENs without the move counters.
  const fields = text.split(/\s+/);
  const fen = fields.length === 4 ? `${fields.join(' ')} 0 1` : fields.join(' ');
  let game;
  if (validateFen(fen).ok) {
    game = new Chess(fen);
  } else {
    game = new Chess();
    try {
      game.loadPgn(text);
    } catch (err) {
      throw new Error(`Not a valid FEN or PGN: ${err.message}`);
    }
  }
  const illegal = illegalPositionReason(game);
  if (illegal) throw new Error(`Illegal position: ${illegal}`);
  return game;
}
$('btn-load').addEventListener('click', () => {
  el.loadError.textContent = '';
  el.loadDialog.showModal();
});
$('load-cancel').addEventListener('click', () => el.loadDialog.close());
$('load-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  let game;
  try {
    game = parseGame(el.loadText.value.trim());
  } catch (err) {
    el.loadError.textContent = err.message;
    return;
  }
  el.loadDialog.close();
  resetGame(game);
});
$('banner-close').addEventListener('click', hideBanner);
function hideResult() {
  if (el.result.hidden) return;
  el.result.hidden = true;
  $('btn-new').focus({ preventScroll: true });
}
$('result-close').addEventListener('click', hideResult);
document.addEventListener('keydown', (e) => {
  // The Load dialog handles its own Escape (closing itself) and keys.
  if (el.loadDialog.open) return;
  if (e.key === 'Escape') { cancelPromo?.(); select(null); hideResult(); hideBanner(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('select, input, textarea, .promo')) return;
  const n = plies.length, at = viewPly ?? n;
  const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: n }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  view(to);
});

players = { w: normalizePlayer(null), b: normalizePlayer(null) };
wirePlayers();
initPlayers();
resetGame();
fetchConfig().then((c) => {
  config = { ...FALLBACK_CONFIG, ...c, engines: [...c.engines, HUMAN] };
  if (Number.isFinite(c.spentUsd)) spent = c.spentUsd;
  initPlayers();
  initAnalysis();
  renderAll();
}).catch((e) => console.error('Failed to load /api/config', e));
