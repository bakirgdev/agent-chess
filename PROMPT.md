# Prompt to build Agent Chess from scratch

This is the single prompt I would give a coding agent to rebuild this project in one pass. It folds in the requirements that only surfaced midway through the original session and the mistakes that cost time, so nothing has to be rediscovered.

---

Build **Agent Chess**: a small local web app where two AI engines play standard chess against each other while I watch in the browser. Put it in the current directory and publish it as a public GitHub repo `agent-chess` (MIT) at the end.

## Engines

Each side (White, Black) independently picks one engine:

1. **Claude**: only the newest model of each Anthropic tier (Haiku, Sonnet, Opus, Fable), discovered at runtime from the Models API (`GET /v1/models`, newest `created_at` per tier; skip legacy ids that don't match `claude-<tier>-<version>`). Never hardcode a model list.
   - Read each model's `capabilities` and offer only what it supports: thinking (adaptive with `display: "summarized"`, or off), effort levels (`output_config.effort`), and fast mode where available. Turning thinking off differs by model (`disabled` vs `between_tools`), and off is only valid at effort `high` or below; enforce that in both UI and server.
   - Use the official `@anthropic-ai/sdk` with streaming (`.finalMessage()`), not raw fetch. Constrain the answer with structured outputs: a JSON schema whose `move` is an `enum` of the legal SAN moves. Still re-check the move server-side.
   - Prompt: a stable system prompt plus position as FEN, an ASCII board, the move history and the legal move list.
   - Handle `stop_reason` `refusal` and `max_tokens` as errors. Do not add refusal fallbacks that silently switch to a different model; the user chose the model.
2. **TypeSafe Jev** (`POST https://api.typesafe.ai/v1/systemone`, Bearer `TYPESAFE_API_KEY`): a decision model, not a text generator. Ask one `choice` question whose criteria keys are the legal SAN moves. Jev can't search or calculate, so give each option precomputed facts: piece and squares, capture, check, checkmate/draw result, whether the moved piece is attacked/defended, a rough static-exchange material result, which enemy pieces it attacks, whether it develops a minor piece, whether it repeats an earlier position, and whether it allows mate in one. Shuffle option order every turn (Jev favors early options). Show the returned probabilities as the top-5 candidate bars.

Read the official docs (context7 first, then vendor docs) for both APIs before writing code; do not guess endpoints, params or prices.

## Architecture

- Node 22.9+, ES modules, `node:http` server, no framework, no build step. Dependencies: `chess.js` and `@anthropic-ai/sdk` only.
- The browser owns the game loop and posts the full SAN history each turn. The server replays it with chess.js (legality decided server-side), validates the player settings, calls the engine, validates the answer, and returns `{ san, confidence, candidates, thinking, model, costUsd, spentUsd, ms }`.
- `GET /api/config` returns the engine list with per-model options and prices so the UI is fully data-driven.
- `MOCK=1` makes every engine play a random legal move for free, for UI work and tests.

## Money and safety (non-negotiable)

- Every move costs real money. Enforce `BUDGET_USD` (default 1) per server run across all engines, count billed failures too, and set each Claude call's `max_tokens` so one move can't exceed the remaining budget. Serialize moves so parallel requests can't race the cap.
- Lock the API to the app's own page: bind `127.0.0.1`, require `Host` to be `localhost:PORT`/`127.0.0.1:PORT` (DNS rebinding), refuse foreign `Origin`s, and require `Content-Type: application/json` on POST (forces a CORS preflight, so other sites can't trigger spend with `no-cors` text/plain posts).
- Send a strict CSP (`default-src 'self'`, no inline script/style), `nosniff`, `frame-ancestors 'none'`.
- Keys live only in `.env` (gitignored, with a committed `.env.example`); never print them. Render all model-controlled text with `textContent` or escaping.
- While testing against real APIs, stay under $1 total per provider and prefer the cheapest settings.

## UI

Mimic chess.com's default dark game screen closely:

- **Board:** green board (`#EBECD0` / `#739552`), coordinates inside the squares, last-move highlights (`#F5F682` / `#B9CA43`), a red radial glow on a king in check, and pieces that slide with a CSS transform (keep element identity across moves; handle captures, en passant, castling and promotion).
- **Player bars:** avatar, engine name with model/effort tag, captured pieces with material difference, and a clock-style box showing thinking time.
- **Sidebar:** move list, a reasoning panel (Claude's summarized thinking or Jev's candidate bars), spend vs budget, a per-side engine/thinking/effort/fast selector persisted in localStorage, Start/Pause/Resume, New game, Flip, Copy PGN, and move delay.
- **Game over:** a result card for checkmate, stalemate, repetition, insufficient material or the 50-move rule.
- **Flow:** don't auto-start, since that spends money. Pause finishes the in-flight move.
- **Layout:** works at 400 px width.

Use the cburnett piece SVGs from `@lichess-org/chessground` and credit them correctly: they are GPLv2+ per lichess's COPYING.md, not MIT.

## Quality bar

- Verify everything by running it: `node:test` tests for rules/request validation/security checks/engine prompt facts (no network), a mock-mode browser pass with zero console errors, and a few real moves per engine family.
- Report real costs and real failures; say what wasn't tested.
- README with a screenshot, quick start, config table, architecture, cost notes and security notes. CI on GitHub Actions (least-privilege `permissions`, actions pinned to commit SHAs) running `npm test`. Dependabot for npm and actions.
- Keep the code small and readable. Prefer deleting code to adding options.
