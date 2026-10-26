# Agent Chess

Local web app: AI engines (Claude models, TypeSafe Jev) or a human play chess in the browser. README.md covers features, setup and architecture; this file covers what to know before changing code.

## Commands

```sh
npm install
npm start          # http://localhost:3000, loads .env if present
MOCK=1 npm start   # random legal moves, no API calls, no cost
npm test           # node:test, never touches a paid API
```

## Stack

- Node 22.9+, ES modules, `node:http`, no framework, no build step, no bundler.
- Runtime dependencies: `chess.js` and `@anthropic-ai/sdk` only. Ask before adding any.
- `public/` is vanilla browser JS; `/vendor/chess.js` is served straight from `node_modules`.

## Layout

| File | Role |
|---|---|
| `server.js` | HTTP server, Host/Origin/CSP checks, static files, `/api/config`, `/api/move`, budget, move queue |
| `claude.js` | Model discovery from the Models API, settings validation, prompt, structured output, cost |
| `jev.js` | Jev option facts per legal move, request, retries |
| `errors.js` | `httpError(status, message, extra)`, the only error shape the server sends |
| `public/app.js` | Game loop, board rendering and animation, human input, move browsing, FEN/PGN load, settings UI, PGN |
| `public/sound.js` | WebAudio move sounds and the mute setting |
| `test/` | `server.test.js` spawns the server in mock mode; `engines.test.js` unit-tests prompts and validation |

## Invariants

- The browser owns the game loop and posts the start FEN plus the full SAN history; the server replays it and decides legality. The Human engine exists only in the browser (`HUMAN` in `app.js`); its moves reach the server inside the next engine request's history. Never trust a client-sent position or an engine's move without checking it against `chess.moves()`.
- Every real move costs money. Keep `BUDGET_USD` enforced, count billed failures (`err.costUsd`), size Claude's `max_tokens` from the remaining budget, and keep moves serialized through `queue`.
- Claude model ids, capabilities and options come from the Models API at runtime. Never hardcode a model list; only `PRICES` in `claude.js` is a table, and unknown models fall back to `UNKNOWN_PRICE`.
- Thinking off is only valid at effort `high` or below (`EFFORTS_WITHOUT_THINKING`); enforce it in both UI and server.
- Jev favors early options, so option order is shuffled every turn. `describeMove` plays and undoes on the live game; it must leave history untouched (tested).
- Security: bind `127.0.0.1`, keep the Host allowlist, Origin check, `application/json`-only POST and strict CSP (no inline script or style). Render model text with `textContent` or `esc()`.

## Testing

- Tests run with `MOCK=1` and a dead `ANTHROPIC_BASE_URL`; keep it that way so `npm test` is free.
- UI changes: run `MOCK=1 npm start`, play a game at 0s delay, check for console errors and for no horizontal scroll at 400px width.
- Real-API checks: only on request, cheapest settings (Haiku low effort, Jev), a few moves, and report the cost printed in the server log.

## Gotchas

- `.env` holds the API keys and is gitignored; never print or commit it.
- The cburnett pieces in `public/pieces.css` are GPLv2+, not MIT; keep the README credit.
- Prices in `claude.js` carry a "checked" date; update it when you change them.
