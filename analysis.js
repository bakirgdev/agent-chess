// Optional native Stockfish (e.g. `brew install stockfish`) for the eval bar and move grades.
// The binary is a separate program the user installs; nothing GPL is bundled with the server.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { availableParallelism } from 'node:os';
import { uciClient } from './public/uci.js';

const BIN = process.env.STOCKFISH_PATH || 'stockfish';
const THREADS = Math.max(1, Math.min(4, availableParallelism() - 1));

let enginePromise;

// Resolves to a UCI client, or null when Stockfish isn't installed. One process serves the whole run.
export function nativeEngine() {
  enginePromise ??= new Promise((resolve) => {
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    const uci = uciClient((cmd) => proc.stdin.write(`${cmd}\n`));
    let ready = false;
    const timer = setTimeout(() => {
      console.error(`${BIN} did not answer the UCI handshake; native analysis is off`);
      proc.kill();
      resolve(null);
    }, 5000);
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') console.log(`Native Stockfish not found (${BIN}); install it with: brew install stockfish`);
      else console.error('Could not start Stockfish:', err.message);
      resolve(null);
    });
    proc.stdin.on('error', (err) => uci.fail(err));
    proc.on('exit', (code) => {
      // A crash mid-run fails the pending search; the next request starts a fresh process.
      clearTimeout(timer);
      uci.fail(new Error(`Stockfish exited (code ${code})`));
      // Only a crash after a good start is retried; a missing binary stays off for this run.
      if (ready) enginePromise = undefined;
      resolve(null);
    });
    createInterface({ input: proc.stdout }).on('line', (line) => {
      if (line === 'uciok') {
        clearTimeout(timer);
        ready = true;
        proc.stdin.write(`setoption name Threads value ${THREADS}\nsetoption name Hash value 64\n`);
        resolve(uci);
      }
      uci.feed(line);
    });
    proc.stdin.write('uci\n');
  });
  return enginePromise;
}
