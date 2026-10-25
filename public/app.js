import { Chess, DEFAULT_POSITION, validateFen } from '/vendor/chess.js';
import * as sound from '/sound.js';

const $ = (id) => document.getElementById(id);
const FILES = 'abcdefgh';
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ORDER = ['p', 'n', 'b', 'r', 'q'];
const NAMES = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' };

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
  budgetUsd: null, spentUsd: 0,
};
const STORE_KEY = 'agent-chess.players.v1';
let config = FALLBACK_CONFIG;
let players = { w: null, b: null };
const sideModel = { w: null, b: null }; // last model id reported per side, with the engine that reported it

let chess, state, flipped = false, gen = 0, loopGen = null, controller = null;
let spent = 0;
let moveLog, totals, thinkingSince, tick, lastThink, lastResult;
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
  clearInterval(tick);
  chess = game;
  startFen = chess.getHeaders().FEN ?? DEFAULT_POSITION;
  viewPly = null;
  selected = null;
  state = 'idle';
  moveLog = chess.history().map((san) => ({ san, conf: null, model: 'imported' }));
  totals = { w: 0, b: 0, ms: 0 };
  thinkingSince = null;
  lastThink = null;
  lastResult = gameOutcome();
  el.result.hidden = true;
  hideBanner();
  buildBoard();
  if (lastResult) { state = 'over'; showResult(lastResult); }
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
function positionAt(ply) {
  const g = new Chess(startFen);
  for (const san of chess.history().slice(0, ply)) g.move(san);
  return g;
}
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
  const last = pos.history({ verbose: true }).at(-1);
  if (last) { squareEls.get(last.from).classList.add('hl'); squareEls.get(last.to).classList.add('hl'); }
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
  select(sq);
  const node = pieceEls.get(sq);
  if (!node) return;
  drag = { node, from: sq, x: ev.clientX, y: ev.clientY, moved: false };
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
  const { node, from, moved } = drag;
  drag = null;
  node.classList.remove('dragging');
  if (!moved) return;
  const sq = dropped ? squareAt(ev) : null;
  if (sq && sq !== from && movesFrom(from).some((m) => m.to === sq)) tryMove(from, sq);
  else place(node, from);
}
el.board.addEventListener('pointerup', (ev) => endDrag(ev, true));
el.board.addEventListener('pointercancel', (ev) => endDrag(ev, false));

/* ---------- move list browsing ---------- */
function view(ply) {
  const n = chess.history().length;
  const next = ply === null || ply >= n || n === 0 ? null : Math.max(0, ply);
  if (next === viewPly) return;
  cancelPromo?.();
  viewPly = next;
  selected = null;
  buildBoard();
  renderMoves();
  renderStatus();
  renderControls();
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
const fmtPrice = (p) => `$${Number(p[0])}/$${Number(p[1])}`;
function allowedEfforts(e, thinking) {
  const all = effortsOf(e);
  return thinking === 'off' ? all.filter((f) => (config.effortsWithoutThinking || []).includes(f)) : all;
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
  if (engineOf(players[color].engine).human) return HUMAN.label;
  return `${engineOf(players[color].engine).label} (${[modelFor(color), ...detailParts(color)].join(', ')})`;
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
    if (modes.length > 1) $(`think-${c}`).value = p.thinking;
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
      if ([...sel.options].map((o) => o.value).join() !== modes.join()) {
        sel.replaceChildren(...modes.map((m) => new Option(cap(m), m)));
        sel.value = p.thinking;
      }
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
  for (const m of chess.history({ verbose: true })) if (m.captured) caps[m.color].push(m.captured);
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
function renderBar(node, color) {
  const caps = captured();
  const mine = caps[color];
  const oppColor = color === 'w' ? 'b' : 'w';
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
    <div class="clock" role="timer" aria-label="${color === 'w' ? 'White' : 'Black'} thinking time">${fmtClock(clockMs)}</div>`;
}
const monogram = (e) => { const w = e.label.split(' '); return (w[0] === 'Claude' && w[1] ? w[1] : w[0])[0].toUpperCase(); };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---------- panels ---------- */
function renderMoves() {
  const rows = [];
  // A loaded position can start at any move number, with Black to move.
  const [, side, , , , fullmove] = startFen.split(' ');
  const offset = side === 'b' ? 1 : 0;
  for (let i = 0; i < moveLog.length + offset; i += 2) {
    const cell = (k) => {
      const j = k - offset, m = moveLog[j];
      if (!m) return '<span></span>';
      const tip = m.conf == null ? (m.model || 'unknown model') : `Confidence: ${Math.round(m.conf * 100)}%`;
      const viewing = viewPly === j + 1;
      const cls = `mv${j === moveLog.length - 1 ? ' last' : ''}${viewing ? ' viewing' : ''}`;
      return `<button type="button" class="${cls}" data-ply="${j + 1}" title="${esc(tip)}"${viewing ? ' aria-current="true"' : ''}>${esc(m.san)}</button>`;
    };
    rows.push(`<div class="mrow"><span class="mnum">${Number(fullmove) + i / 2}.</span>${cell(i)}${cell(i + 1)}</div>`);
  }
  if (lastResult) rows.push(`<div class="mres"><b>${lastResult.score}</b> &nbsp;${esc(lastResult.title)} (${esc(lastResult.reason)})</div>`);
  // The list is rebuilt on every render; keep keyboard focus on the same move.
  const focused = el.moves.contains(document.activeElement) ? document.activeElement.dataset.ply : undefined;
  el.moves.innerHTML = rows.join('');
  if (focused) el.moves.querySelector(`[data-ply="${focused}"]`)?.focus({ preventScroll: true });
  if (viewPly === null) el.moves.scrollTop = el.moves.scrollHeight;
  else el.moves.querySelector('.viewing')?.scrollIntoView({ block: 'nearest' });
}
function renderThink() {
  const title = lastThink ? `${lastThink.label}'s thinking` : 'Thinking';
  $('think-title').textContent = title;
  $('think').setAttribute('aria-label', title);
  if (!lastThink) { el.think.innerHTML = '<p class="muted">No decision yet.</p>'; return; }
  const { san, candidates, thinking } = lastThink;
  if (candidates.length) {
    const shown = candidates.slice(0, 5).map((c) => ({ san: c.san, pct: Math.max(0, Math.min(100, c.p * 100)) }));
    el.think.innerHTML = shown.map((c) => `<div class="cand${c.san === san ? ' pick' : ''}"><span class="san">${esc(c.san)}</span>
      <span class="track"><span class="fill"></span></span>
      <span class="pct">${c.pct < 10 ? c.pct.toFixed(1) : Math.round(c.pct)}%</span></div>`).join('');
    el.think.querySelectorAll('.fill').forEach((f, i) => { f.style.width = `${shown[i].pct}%`; });
  } else if (thinking) {
    el.think.innerHTML = `<div class="think-text" tabindex="0" role="region" aria-label="${esc(title)}">${esc(thinking)}</div>`;
  } else {
    el.think.innerHTML = '<p class="muted">No reasoning returned (thinking off)</p>';
  }
}
function renderStats() {
  const n = moveLog.length;
  const avg = n ? Math.round(totals.ms / n) : 0;
  el.stats.textContent = `Moves: ${n} · Spent: $${spent.toFixed(4)}${config.budgetUsd == null ? '' : ` of $${Number(config.budgetUsd).toFixed(4)}`} · Avg: ${avg} ms/move`;
}
function sideName(c) { return c === 'w' ? 'White' : 'Black'; }
function renderStatus() {
  const s = el.status;
  if (state === 'idle') s.textContent = 'Press Start to begin';
  else if (state === 'over') s.textContent = lastResult ? `${lastResult.title} · ${lastResult.reason}` : 'Game over';
  else if (thinkingSince && state === 'paused') s.textContent = `Pausing after ${sideName(chess.turn())}'s move\u2026`;
  else if (humanWait) s.textContent = `Your move (${sideName(chess.turn())})`;
  else if (thinkingSince) s.textContent = `${sideName(chess.turn())} is thinking\u2026`;
  else if (state === 'paused') s.textContent = 'Paused';
  else s.textContent = `${sideName(chess.turn())} to move`;
  if (viewPly !== null) s.textContent += ` \u00b7 viewing move ${viewPly} (End for live)`;
}
function renderControls() {
  el.primary.textContent = state === 'idle' ? 'Start' : state === 'running' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start';
  el.primary.disabled = state === 'over';
  el.primary.setAttribute('aria-label', el.primary.textContent === 'Start' ? 'Start game' : `${el.primary.textContent} game`);
  const turn = state === 'over' ? 'Game over.' : `${sideName(chess.turn())} to move.`;
  el.board.setAttribute('aria-label', `Chess board. ${turn}`);
  // A reply is reported against the side's current engine, so settings can't change while a move is in flight.
  for (const n of document.querySelectorAll('.players select, .players input')) n.disabled = thinkingSince != null;
  el.board.classList.toggle('interactive', canMove());
  const sanForm = $('san-form');
  sanForm.hidden = !canMove();
  if (!sanForm.hidden && refocusSan) { refocusSan = false; $('san-input').focus(); }
}
function renderBars() {
  const top = flipped ? 'w' : 'b', bottom = flipped ? 'b' : 'w';
  renderBar($('bar-top'), top);
  renderBar($('bar-bottom'), bottom);
}
function renderAll() { renderBars(); renderMoves(); renderThink(); renderStats(); renderStatus(); renderControls(); }

/* ---------- game flow ---------- */
function showBanner(msg) { el.bannerText.textContent = msg; el.banner.hidden = false; }
function hideBanner() { el.banner.hidden = true; }

function gameOutcome() {
  if (chess.isCheckmate()) {
    const w = chess.turn() === 'b';
    return { title: `${w ? 'White' : 'Black'} Won`, reason: 'by checkmate', score: w ? '1-0' : '0-1' };
  }
  const draw = (reason) => ({ title: 'Draw', reason, score: '½-½' });
  if (chess.isStalemate()) return draw('by stalemate');
  if (chess.isThreefoldRepetition()) return draw('by threefold repetition');
  if (chess.isInsufficientMaterial()) return draw('by insufficient material');
  if (chess.isDrawByFiftyMoves()) return draw('by the 50-move rule');
  return null;
}
function showResult(o) {
  $('result-title').textContent = o.title;
  $('result-reason').textContent = o.reason;
  $('result-score').textContent = o.score;
  el.result.hidden = false;
  $('result-new').focus({ preventScroll: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    body: JSON.stringify({ fen: startFen, moves: chess.history(), player }), signal,
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
          thinkingSince = null;
          clearInterval(tick);
          return;
        }
        r = { san, ms: Math.round(performance.now() - thinkingSince), model: HUMAN.model };
      } else {
        mine = controller = new AbortController();
        try {
          r = await requestMove(color, mine.signal);
        } catch (e) {
          if (gen !== myGen || e.name === 'AbortError') return;
          thinkingSince = null;
          clearInterval(tick);
          state = 'paused';
          showBanner(e.message || 'Network error');
          renderAll();
          return;
        }
        if (gen !== myGen) return;
      }
      thinkingSince = null;
      clearInterval(tick);
      let m;
      try {
        m = chess.move(r.san);
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
      const castle = m.isKingsideCastle() || m.isQueensideCastle();
      sound.play(out ? 'end' : chess.inCheck() ? 'check' : m.isCapture() ? 'capture' : castle ? 'castle' : 'move');
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
});
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
  if (validateFen(fen).ok) return new Chess(fen);
  const game = new Chess();
  try {
    game.loadPgn(text);
  } catch (err) {
    throw new Error(`Not a valid FEN or PGN: ${err.message}`);
  }
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
  if (e.key === 'Escape') { cancelPromo?.(); select(null); hideResult(); hideBanner(); return; }
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('select, input, textarea, dialog, .promo')) return;
  const n = chess.history().length, at = viewPly ?? n;
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
  renderAll();
}).catch((e) => console.error('Failed to load /api/config', e));
