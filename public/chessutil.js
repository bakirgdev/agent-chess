// Chess helpers shared by the server and the browser; they take chess.js objects, so no imports.
export const SIDES = { w: 'White', b: 'Black' };

// SAN movetext for the last `plies` moves of a verbose history. Numbers come from the FEN before each
// move so games started from a custom position count correctly.
export function movetext(history, plies = Infinity) {
  return history
    .slice(-plies)
    .map((m, i) => {
      const n = m.before.split(' ')[5];
      if (m.color === 'w') return `${n}. ${m.san}`;
      return i === 0 ? `${n}... ${m.san}` : m.san;
    })
    .join(' ');
}

// chess.js accepts a FEN where the side not to move is in check, but Stockfish crashes on it.
export function illegalPositionReason(chess) {
  const idle = chess.turn() === 'w' ? 'b' : 'w';
  for (const row of chess.board()) {
    for (const piece of row) {
      if (piece?.type === 'k' && piece.color === idle && chess.isAttacked(piece.square, chess.turn())) {
        return 'the side not to move is in check';
      }
    }
  }
  return null;
}
