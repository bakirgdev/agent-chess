import { Chess } from '/vendor/chess.js';

const $ = (id) => document.getElementById(id);
const FILES = 'abcdefgh';
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const ORDER = ['p', 'n', 'b', 'r', 'q'];

const el = {
  board: $('board'), result: $('result'), banner: $('banner'), bannerText: $('banner-text'),
  status: $('status'), moves: $('moves'), think: $('think-body'), stats: $('stats'),
  primary: $('btn-primary'), delay: $('delay'), pgn: $('btn-pgn'),
};

const FALLBACK_CONFIG = {
  engines: [{ id: 'jev', label: 'Jev', anthropic: false, model: 'jev-latest' }],
  effortsWithoutThinking: ['low', 'medium', 'high'],
  budgetTokensOptions: [1024, 4096, 16384, 32768],
  budgetUsd: null, spentUsd: 0,
};
const STORE_KEY = 'jev.players.v2';
let config = FALLBACK_CONFIG;
let players = { w: null, b: null };
const sideModel = { w: null, b: null }; // last model id reported per side, with the engine that reported it

let chess, state, flipped = false, gen = 0, loopGen = null, controller = null;
let spent = 0;
let moveLog, totals, thinkingSince, tick, lastThink, lastResult, resultDismissed;
let squareEls = new Map();
let pieceEls = new Map();
let piecesLayer;

function resetGame() {
  gen++;
  if (controller) controller.abort();
  controller = null;
  clearInterval(tick);
  chess = new Chess();
  state = 'idle';
  moveLog = [];
  totals = { w: 0, b: 0, ms: 0 };
  thinkingSince = null;
  lastThink = null;
  lastResult = null;
  resultDismissed = false;
  el.result.hidden = true;
  hideBanner();
  buildBoard();
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
function buildBoard() {
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
  for (const rank of chess.board()) for (const p of rank) if (p) makePiece(p.color, p.type, p.square);
  updateHighlights();
}
function updateHighlights() {
  for (const d of squareEls.values()) d.classList.remove('hl', 'check');
  const last = chess.history({ verbose: true }).at(-1);
  if (last) { squareEls.get(last.from).classList.add('hl'); squareEls.get(last.to).classList.add('hl'); }
  if (chess.inCheck()) {
    for (const rank of chess.board()) for (const p of rank) {
      if (p && p.type === 'k' && p.color === chess.turn()) squareEls.get(p.square).classList.add('check');
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

/* ---------- players ---------- */
const engineOf = (id) => config.engines.find((e) => e.id === id) || config.engines[0];
const modesOf = (e) => (e.anthropic && Array.isArray(e.thinking) ? e.thinking : []);
const effortsOf = (e) => (e.anthropic && Array.isArray(e.efforts) ? e.efforts : []);
const cap = (t) => t[0].toUpperCase() + t.slice(1);
const fmtTok = (n) => `${Math.round(n / 1024)}K`;
const fmtPrice = (p) => `$${Number(p[0])}/$${Number(p[1])}`;
const budgetOptions = () => (Array.isArray(config.budgetTokensOptions) && config.budgetTokensOptions.length ? config.budgetTokensOptions : [1024, 4096, 16384, 32768]);
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
function defaultPlayer(e) {
  const modes = modesOf(e), efforts = effortsOf(e), bo = budgetOptions();
  return clampEffort({
    engine: e.id,
    thinking: modes.length ? (modes.includes(e.defaultThinking) ? e.defaultThinking : modes[0]) : null,
    effort: efforts.length ? (efforts.includes(e.defaultEffort) ? e.defaultEffort : efforts[0]) : null,
    budget: bo.includes(4096) ? 4096 : bo[0],
    fast: false,
  });
}
function normalizePlayer(raw) {
  const e = raw && config.engines.find((x) => x.id === raw.engine);
  if (!e) return defaultPlayer(config.engines[0]);
  const d = defaultPlayer(e);
  return clampEffort({
    engine: e.id,
    thinking: modesOf(e).includes(raw.thinking) ? raw.thinking : d.thinking,
    effort: effortsOf(e).includes(raw.effort) ? raw.effort : d.effort,
    budget: budgetOptions().includes(raw.budget) ? raw.budget : d.budget,
    fast: e.fast === true && raw.fast === true,
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
  return `${engineOf(players[color].engine).label} (${[modelFor(color), ...detailParts(color)].join(', ')})`;
}
function renderTitle() {
  const t = `${engineOf(players.w.engine).label} vs ${engineOf(players.b.engine).label}`;
  $('title').textContent = t;
  document.title = t;
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
  const mk = (e) => new Option(e.anthropic ? `${e.label} · ${e.price ? fmtPrice(e.price) : ''}`.replace(/ · $/, '') : e.label, e.id);
  for (const c of ['w', 'b']) {
    const sel = $(`eng-${c}`);
    const groups = [['TypeSafe', config.engines.filter((e) => !e.anthropic)], ['Anthropic', config.engines.filter((e) => e.anthropic)]];
    sel.replaceChildren(...groups.filter(([, l]) => l.length).map(([name, l]) => {
      const g = document.createElement('optgroup');
      g.label = name;
      g.append(...l.map(mk));
      return g;
    }));
    $(`bud-${c}`).replaceChildren(...budgetOptions().map((n) => new Option(fmtTok(n), String(n))));
  }
  loadPlayers();
  renderPlayers();
}
function wirePlayers() {
  for (const c of ['w', 'b']) {
    $(`eng-${c}`).addEventListener('change', (ev) => {
      players[c] = defaultPlayer(engineOf(ev.target.value));
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
const value = (arr) => arr.reduce((s, t) => s + VALUES[t], 0);
function fmtClock(ms) {
  const t = Math.floor(ms / 100) / 10;
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
}
function renderBar(node, color) {
  const caps = captured();
  const mine = caps[color], theirs = caps[color === 'w' ? 'b' : 'w'];
  const adv = value(mine) - value(theirs);
  const oppColor = color === 'w' ? 'b' : 'w';
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
  for (let i = 0; i < moveLog.length; i += 2) {
    const cell = (j) => {
      const m = moveLog[j];
      if (!m) return '<span></span>';
      const tip = m.conf == null ? (m.model || 'unknown model') : `Confidence: ${Math.round(m.conf * 100)}%`;
      return `<span class="mv${j === moveLog.length - 1 ? ' last' : ''}" title="${esc(tip)}">${esc(m.san)}</span>`;
    };
    rows.push(`<div class="mrow"><span class="mnum">${i / 2 + 1}.</span>${cell(i)}${cell(i + 1)}</div>`);
  }
  if (lastResult) rows.push(`<div class="mres"><b>${lastResult.score}</b> &nbsp;${esc(lastResult.title)} (${esc(lastResult.reason)})</div>`);
  el.moves.innerHTML = rows.join('');
  el.moves.scrollTop = el.moves.scrollHeight;
}
function renderThink() {
  const title = lastThink ? `${lastThink.label}'s thinking` : 'Thinking';
  $('think-title').textContent = title;
  $('think').setAttribute('aria-label', title);
  if (!lastThink) { el.think.innerHTML = '<p class="muted">No decision yet.</p>'; return; }
  const { san, candidates, thinking } = lastThink;
  if (candidates.length) {
    el.think.innerHTML = candidates.slice(0, 5).map((c) => {
      const pct = Math.max(0, Math.min(100, c.p * 100));
      return `<div class="cand${c.san === san ? ' pick' : ''}"><span class="san">${esc(c.san)}</span>
      <span class="track"><span class="fill" style="display:block;width:${pct}%"></span></span>
      <span class="pct">${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</span></div>`;
    }).join('');
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
  else if (thinkingSince) s.textContent = `${sideName(chess.turn())} is thinking\u2026`;
  else if (state === 'paused') s.textContent = 'Paused';
  else s.textContent = `${sideName(chess.turn())} to move`;
}
function renderControls() {
  el.primary.textContent = state === 'idle' ? 'Start' : state === 'running' ? 'Pause' : state === 'paused' ? 'Resume' : 'Start';
  el.primary.disabled = state === 'over';
  el.primary.setAttribute('aria-label', el.primary.textContent === 'Start' ? 'Start game' : `${el.primary.textContent} game`);
  const turn = state === 'over' ? 'Game over.' : `${sideName(chess.turn())} to move.`;
  el.board.setAttribute('aria-label', `Chess board. ${turn}`);
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
  tick = setInterval(() => { renderBars(); }, 100);
}

async function requestMove(color, signal) {
  const p = players[color], isAnth = engineOf(p.engine).anthropic;
  const player = isAnth
    ? { engine: p.engine, thinking: p.thinking, effort: p.effort, budgetTokens: p.thinking === 'budget' ? p.budget : null, fast: p.fast }
    : { engine: p.engine, effort: null, budgetTokens: null, fast: false };
  const res = await fetch('/api/move', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ moves: chess.history(), player }), signal,
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
  try {
    while (state === 'running' && gen === myGen) {
      const color = chess.turn();
      controller = new AbortController();
      thinkingSince = performance.now();
      startClockTick();
      renderAll();
      let r;
      try {
        r = await requestMove(color, controller.signal);
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
      thinkingSince = null;
      clearInterval(tick);
      const eng = engineOf(players[color].engine);
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
      lastThink = {
        san: m.san, label: eng.label,
        candidates: Array.isArray(r.candidates) ? r.candidates : [],
        thinking: typeof r.thinking === 'string' && r.thinking.trim() ? r.thinking : null,
      };
      animateMove(m);
      const out = gameOutcome();
      if (out) {
        state = 'over';
        lastResult = out;
        showResult(out);
        renderAll();
        return;
      }
      renderAll();
      if (state !== 'running') break;
      const d = Number(el.delay.value);
      if (d) await sleep(d);
    }
  } finally {
    if (loopGen === myGen) loopGen = null;
    controller = null;
    if (gen === myGen && state === 'paused') renderAll();
  }
}

function onPrimary() {
  if (state === 'idle' || state === 'paused') {
    hideBanner();
    state = 'running';
    renderAll();
    loop();
  } else if (state === 'running') {
    state = 'paused';
    renderAll();
  }
}

function buildPgn() {
  const c = new Chess();
  for (const san of chess.history()) c.move(san);
  const d = new Date();
  const date = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  const result = lastResult ? lastResult.score.replace('½-½', '1/2-1/2') : '*';
  c.setHeader('Event', `${engineOf(players.w.engine).label} vs ${engineOf(players.b.engine).label}`);
  c.setHeader('Site', 'Local');
  c.setHeader('Date', date);
  c.setHeader('White', playerDesc('w'));
  c.setHeader('Black', playerDesc('b'));
  c.setHeader('Result', result);
  return c.pgn();
}
async function copyPgn() {
  const text = buildPgn();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) { showBanner('Could not copy PGN to the clipboard'); return; }
  }
  const prev = el.pgn.textContent;
  el.pgn.textContent = 'Copied!';
  setTimeout(() => { el.pgn.textContent = prev; }, 1200);
}

/* ---------- wiring ---------- */
el.primary.addEventListener('click', onPrimary);
$('btn-new').addEventListener('click', resetGame);
$('result-new').addEventListener('click', resetGame);
$('btn-flip').addEventListener('click', () => {
  flipped = !flipped;
  buildBoard();
  renderBars();
});
el.pgn.addEventListener('click', copyPgn);
$('banner-close').addEventListener('click', hideBanner);
$('result-close').addEventListener('click', () => { el.result.hidden = true; resultDismissed = true; });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { el.result.hidden = true; hideBanner(); }
});

players = { w: normalizePlayer(null), b: normalizePlayer(null) };
wirePlayers();
initPlayers();
resetGame();
fetch('/api/config').then((r) => r.json()).then((c) => {
  if (!c || !Array.isArray(c.engines) || !c.engines.length) throw new Error('Malformed /api/config');
  config = { ...FALLBACK_CONFIG, ...c };
  if (Number.isFinite(c.spentUsd)) spent = c.spentUsd;
  initPlayers();
  renderAll();
}).catch((e) => console.error('Failed to load /api/config', e));
