// Minimal UCI client shared by the native Stockfish (analysis.js, server) and the WASM build (app.js,
// browser). `send` writes one command (it may throw); feed every line the engine prints to `feed`.
export function uciClient(send, graceMs = 5000) {
  let pending = null;
  let chain = Promise.resolve();
  // bestmove replies still owed by searches that timed out; they must not answer the next search.
  let stale = 0;

  function feed(line) {
    if (line.startsWith('bestmove') && stale) {
      stale--;
      return;
    }
    if (!pending) return;
    if (line.startsWith('bestmove')) {
      const { resolve, lines, depth, timer } = pending;
      clearTimeout(timer);
      pending = null;
      resolve({ depth, lines: lines.filter(Boolean) });
      return;
    }
    const t = line.split(' ');
    // Bound scores are partial results from an aspiration window; only exact scores are kept.
    if (t[0] !== 'info' || !t.includes('pv') || t.includes('lowerbound') || t.includes('upperbound')) return;
    const at = (key) => t.indexOf(key);
    const score = at('score');
    if (score < 0) return;
    const rank = at('multipv') >= 0 ? Number(t[at('multipv') + 1]) : 1;
    const kind = t[score + 1], value = Number(t[score + 2]);
    pending.depth = Number(t[at('depth') + 1]);
    pending.lines[rank - 1] = {
      move: t[at('pv') + 1],
      cp: kind === 'cp' ? value : null,
      mate: kind === 'mate' ? value : null,
    };
  }

  // Resolves to { depth, lines: [{ move, cp, mate }] }, best line first. Scores are from the side to move.
  function analyse(fen, { movetime, multipv }) {
    const run = chain.then(() => new Promise((resolve, reject) => {
      // A hung engine would otherwise block every search queued behind this one.
      const timer = setTimeout(() => {
        stale++;
        fail(new Error('Stockfish did not answer in time'));
        try { send('stop'); } catch { /* engine already gone: nothing left to stop */ }
      }, movetime + graceMs);
      pending = { resolve, reject, lines: [], depth: 0, timer };
      try {
        send(`setoption name MultiPV value ${multipv}`);
        send(`position fen ${fen}`);
        send(`go movetime ${movetime}`);
      } catch (err) {
        fail(err);
      }
    }));
    chain = run.catch(() => {});
    return run;
  }

  // The engine died: fail the search in progress instead of leaving it hanging.
  function fail(err) {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(err);
    pending = null;
  }

  return { feed, analyse, fail };
}
