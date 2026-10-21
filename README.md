# Jev Chess

Local chess.com-style board where AI engines play standard chess against each other. Each side can be TypeSafe's Jev or the newest Claude model of each tier (currently Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1), with that model's own thinking and effort options.

```sh
npm install
printf 'TYPESAFE_API_KEY=...\nANTHROPIC_API_KEY=...\n' > .env
npm start            # http://localhost:3000, pick engines, press Start
```

Free UI demo with random moves (no move API calls): `MOCK=1 node --env-file=.env server.js`.

| Env var | Default | Purpose |
|---|---|---|
| `TYPESAFE_API_KEY` | needed for Jev | Bearer token for `api.typesafe.ai` |
| `ANTHROPIC_API_KEY` | needed for Claude | Anthropic API key; without it only Jev is listed |
| `JEV_MODEL` | `jev-latest` | Jev model id (`jev-preview`, `jev-1.13.0`, ...) |
| `BUDGET_USD` | `1` | Hard cap on spend per server run, all engines together. Each Claude call's `max_tokens` is also capped so one move cannot overshoot it. Restart to reset. |
| `MOCK` | off | `1` = every engine plays random legal moves for free |
| `PORT` | `3000` | |

## Engines

- **Jev** (`jev.js`): one `choice` question whose options are exactly the legal moves (SAN). Jev is a fast decision model, not a search engine, so each option carries precomputed facts: captures, check, checkmate, draw, piece safety, likely material result, attacked pieces, development, repetition, and whether it allows mate next move. Option order is shuffled every turn because Jev favors early options. About $0.0001 per move.
- **Claude** (`claude.js`): the newest model per tier (by `created_at`) and each model's options come from the Anthropic Models API (`capabilities`), so the UI only offers what a model accepts:
  - Thinking: `Adaptive` (summary shown in the sidebar), `Off` (`disabled` on Haiku 5.5, `between_tools` on Sonnet 5.5). Fable 5.1 and Opus 5.5 always think.
  - Effort: `low` to `max`; with thinking off, at most `high`.
  - Fast mode: Opus 5.5 ($8/$40 per MTok instead of $4/$20).
  - The answer is constrained by a JSON schema whose `move` enum is the legal move list, and is checked again server-side.

`server.js` replays the SAN history with chess.js for every request, so legality is decided server-side; `public/app.js` owns the game loop and UI.

Pieces: cburnett set by Colin M.L. Burnett (CC BY-SA 3.0), extracted from lichess chessground.
