import Anthropic from '@anthropic-ai/sdk';

// USD per million [input, output] tokens, https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-10-21).
// Thinking is billed as output. Haiku 5.5's rate is for prompts up to 100K tokens; ours are ~1-3K.
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
};
// Fast mode (research preview): same model, faster output, premium price.
const FAST_PRICES = { 'claude-opus-5-5': [8, 40] };
// Models missing from the table are priced like the most expensive Claude model ever sold, so the budget cap stays safe.
const UNKNOWN_PRICE = [15, 75];

export const EFFORTS_WITHOUT_THINKING = ['low', 'medium', 'high'];
export const BUDGET_TOKENS = [1024, 4096, 16384, 32768];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Room for the prompt when turning the remaining budget into a max_tokens cap.
const INPUT_TOKENS_RESERVE = 4000;
const MIN_OUTPUT_TOKENS = 2048;

const SYSTEM =
  'You are a strong chess player in a game of standard chess against another AI. ' +
  'Each turn you get the current position and every legal move. ' +
  'Pick the strongest move for the side you play, and answer with that move copied exactly from the legal moves list.';

const SIDES = { w: 'White', b: 'Black' };

let client;
let enginesPromise;

const priceKey = (id) => id.replace(/-\d{8}$/, '');

// Only the newest model of each tier (Haiku, Sonnet, Opus, Fable, ...) by release date.
async function latestPerTier() {
  const newest = new Map();
  for await (const m of client.models.list()) {
    const tier = m.id.match(/^claude-([a-z]+)-/)?.[1] ?? m.id;
    if (!newest.has(tier) || m.created_at > newest.get(tier).created_at) newest.set(tier, m);
  }
  return [...newest.values()];
}

// One entry per offered model, with the options that model accepts, read from the Models API
// capabilities so new models need no code change.
export function listEngines() {
  enginesPromise ??= (async () => {
    client ??= new Anthropic();
    const engines = [];
    for (const m of await latestPerTier()) {
      const caps = m.capabilities ?? {};
      const types = caps.thinking?.types ?? {};
      const has = (t) => types[t]?.supported === true;
      const thinking = [has('adaptive') && 'adaptive', has('enabled') && 'budget', (has('disabled') || has('between_tools')) && 'off'].filter(Boolean);
      const efforts = caps.effort?.supported ? EFFORTS.filter((e) => caps.effort[e]?.supported) : [];
      engines.push({
        id: m.id,
        label: m.display_name,
        anthropic: true,
        price: PRICES[priceKey(m.id)] ?? UNKNOWN_PRICE,
        thinking,
        efforts,
        fast: priceKey(m.id) in FAST_PRICES,
        fastPrice: FAST_PRICES[priceKey(m.id)] ?? null,
        defaultThinking: thinking.includes('adaptive') ? 'adaptive' : (thinking.at(-1) ?? null),
        defaultEffort: efforts.includes('medium') ? 'medium' : (efforts.at(-1) ?? null),
        // Not sent to the browser.
        offType: has('between_tools') ? 'between_tools' : 'disabled',
        maxTokens: m.max_tokens,
      });
    }
    return engines;
  })();
  // Let a failed listing (bad key, network) be retried on the next call.
  enginesPromise.catch(() => {
    enginesPromise = undefined;
  });
  return enginesPromise;
}

export const publicEngine = ({ offType, maxTokens, ...engine }) => engine;

const invalid = (message) => Object.assign(new Error(message), { status: 400 });

// Validates a player config against what the model supports; returns the normalized config.
export function parsePlayer(engine, { thinking, effort = null, budgetTokens = null, fast = false }) {
  if (!engine.thinking.includes(thinking)) throw invalid(`${engine.label} supports thinking: ${engine.thinking.join(', ')}`);
  if (engine.efforts.length) {
    // Without thinking, effort above high is rejected by some models and does nothing useful on the rest.
    const allowed = thinking === 'off' ? engine.efforts.filter((e) => EFFORTS_WITHOUT_THINKING.includes(e)) : engine.efforts;
    if (!allowed.includes(effort)) throw invalid(`effort must be one of ${allowed.join(', ')}`);
  } else if (effort !== null) {
    throw invalid(`${engine.label} has no effort setting`);
  }
  if (thinking === 'budget' && !BUDGET_TOKENS.includes(budgetTokens)) throw invalid(`budgetTokens must be one of ${BUDGET_TOKENS.join(', ')}`);
  if (typeof fast !== 'boolean' || (fast && !engine.fast)) throw invalid(`${engine.label} has no fast mode`);
  return { thinking, effort, budgetTokens: thinking === 'budget' ? budgetTokens : null, fast };
}

function prompt(chess) {
  const side = SIDES[chess.turn()];
  const movetext = chess
    .history()
    .map((san, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${san}` : san))
    .join(' ');
  return [
    `You play ${side}. It is move ${chess.moveNumber()}, ${side} to move.${chess.inCheck() ? ' You are in check.' : ''}`,
    `Position (FEN): ${chess.fen()}`,
    `Board (uppercase = White, lowercase = Black):\n${chess.ascii()}`,
    `Game so far: ${movetext || 'no moves yet'}`,
    `Legal moves: ${chess.moves().join(', ')}`,
  ].join('\n\n');
}

function thinkingParam(engine, { thinking, budgetTokens }) {
  if (thinking === 'adaptive') return { type: 'adaptive', display: 'summarized' };
  if (thinking === 'budget') return { type: 'enabled', budget_tokens: budgetTokens };
  return { type: engine.offType };
}

// Returns { san, thinking, model, costUsd } for the side to move. `maxUsd` caps what this one call may cost.
export async function chooseMove(chess, engine, player, maxUsd) {
  const [usdIn, usdOut] = (player.fast ? engine.fastPrice : engine.price).map((p) => p / 1e6);
  const affordable = Math.floor((maxUsd - INPUT_TOKENS_RESERVE * usdIn) / usdOut);
  const maxTokens = Math.min(engine.maxTokens, affordable);
  const minTokens = (player.budgetTokens ?? 0) + MIN_OUTPUT_TOKENS;
  if (maxTokens < minTokens) {
    throw Object.assign(new Error(`Remaining budget ($${maxUsd.toFixed(4)}) is too small for ${engine.label} with these settings`), {
      status: 402,
    });
  }

  const legal = chess.moves();
  const params = {
    model: engine.id,
    max_tokens: maxTokens,
    system: SYSTEM,
    thinking: thinkingParam(engine, player),
    output_config: {
      ...(player.effort && { effort: player.effort }),
      // The enum makes an illegal or misspelled move impossible to emit.
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { move: { type: 'string', enum: legal } },
          required: ['move'],
          additionalProperties: false,
        },
      },
    },
    messages: [{ role: 'user', content: prompt(chess) }],
  };
  client ??= new Anthropic();
  const stream = player.fast
    ? client.beta.messages.stream({ ...params, speed: 'fast', betas: ['fast-mode-2026-02-01'] })
    : client.messages.stream(params);
  const message = await stream.finalMessage();

  const { usage } = message;
  const costUsd = usage.input_tokens * usdIn + usage.output_tokens * usdOut;
  const fail = (msg) => Object.assign(new Error(msg), { status: 502, costUsd });
  if (message.stop_reason === 'refusal') {
    throw fail(`${engine.label} declined to move (${message.stop_details?.category ?? 'no category'})`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw fail(`${engine.label} used its ${maxTokens}-token limit before answering; lower the effort or thinking budget`);
  }

  const text = message.content.find((b) => b.type === 'text')?.text ?? '';
  let san;
  try {
    san = JSON.parse(text).move;
  } catch {
    throw fail(`${engine.label} returned invalid JSON: ${text.slice(0, 200)}`);
  }
  // Model output is untrusted even with the schema: only accept a move from the list we sent.
  if (!legal.includes(san)) throw fail(`${engine.label} returned an illegal move: ${text.slice(0, 200)}`);

  const reasoning = message.content
    .filter((b) => b.type === 'thinking' && b.thinking)
    .map((b) => b.thinking)
    .join('\n\n');
  console.log(
    `${SIDES[chess.turn()]} ${chess.moveNumber()}. ${san}  ${engine.id} ${JSON.stringify(player)}  ` +
      `in=${usage.input_tokens} out=${usage.output_tokens}  cost=$${costUsd.toFixed(5)}`,
  );
  return { san, thinking: reasoning || null, model: message.model, costUsd };
}
