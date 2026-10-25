// Move sounds synthesized with WebAudio, so there are no audio files to ship or license.
const STORE_KEY = 'agent-chess.muted.v1';
let ctx = null;
let muted = false;
try { muted = localStorage.getItem(STORE_KEY) === '1'; } catch { /* storage unavailable: default to sound on */ }

// A short filtered noise burst reads as a piece landing on wood; pitch and length vary by kind.
const KINDS = {
  move: { freq: 1800, q: 1.2, dur: 0.05, gain: 0.5 },
  capture: { freq: 900, q: 1, dur: 0.09, gain: 0.8 },
  castle: { freq: 1600, q: 1.2, dur: 0.05, gain: 0.5, repeat: 0.09 },
  check: { freq: 2600, q: 6, dur: 0.12, gain: 0.45 },
  end: { freq: 520, q: 8, dur: 0.45, gain: 0.5 },
};

function burst({ freq, q, dur, gain }, at) {
  const frames = Math.ceil(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 3;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const amp = ctx.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(ctx.destination);
  src.start(at);
}

export function play(kind) {
  if (muted || !KINDS[kind]) return;
  unlock();
  const k = KINDS[kind];
  burst(k, ctx.currentTime);
  if (k.repeat) burst(k, ctx.currentTime + k.repeat);
}

export function unlock() {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') ctx.resume();
}

export const isMuted = () => muted;

export function setMuted(value) {
  muted = value;
  try { localStorage.setItem(STORE_KEY, value ? '1' : '0'); } catch { /* storage unavailable: setting lasts for this page only */ }
}
