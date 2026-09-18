/**
 * A stand-in for Jev, so the game is playable without an API key.
 *
 * This is NOT the model. It is a small heuristic that answers the same typed
 * questions over the same wire shape, with a latency draw in Jev's published
 * 70-500 ms band, so the rest of the system cannot tell the difference. It
 * reads contact descriptions with a keyword lexicon, which is exactly where it
 * is worse than the real thing: compound descriptions ("a medevac hull with a
 * turret bolted to it") are the ones it gets wrong.
 *
 * Anything answered here is labelled `simulator` in the HUD.
 */

import type { Snapshot, TargetView } from './protocol.js';
import { HOLD, TEMPO_LEVELS, modeHasIff } from './brain.js';
import type { Answer, SystemOneRequest, SystemOneResponse } from './typesafe.js';

export interface SimOptions {
  /** Published Jev end-to-end latency band. */
  minLatencyMs?: number;
  maxLatencyMs?: number;
  /** 0 = a perfect oracle, 1 = very noisy. */
  noise?: number;
  seed?: number;
  /** Set false to answer instantly (tests). */
  delay?: boolean;
}

export const SIM_MODEL = 'jev-simulator';

/** Markers the simulator can read. Positive = hostile, negative = protected. */
const LEXICON: [RegExp, number][] = [
  [/\bturret|autocannon|\bcannon\b|gun pod|muzzle\b/i, 3.2],
  [/missile|rocket|warhead|ordnance/i, 3.0],
  [/targeting laser|painted|lock warning|seeker/i, 2.6],
  [/\barmed\b|\bweapons?\b|hardpoint/i, 2.2],
  [/attack|strike|hunter|raider|interceptor|gunship/i, 1.8],
  [/aggressive|diving|charging|closing fast|tracking/i, 1.4],
  [/scarred|burnt|no markings|stripped hull/i, 0.6],
  [/drone|quadcopter|contact|rotor|skiff/i, 0.15],
  [/medevac|medical|medic|red cross|casualt|ambulance/i, -3.0],
  [/civilian|press|journalist|survey|census/i, -2.8],
  [/supply|cargo|water|ration|relief|\baid\b/i, -2.4],
  [/unarmed|empty rails|no hardpoints/i, -2.4],
  [/friendly|allied|\bours\b|beacon/i, -2.6],
  [/\bwhite\b|blue livery|marked\b/i, -0.8],
];

function hostilityLogit(desc: string): number {
  let sum = -0.2;
  for (const [re, w] of LEXICON) if (re.test(desc)) sum += w;
  return sum;
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function softmax(logits: number[], temperature = 1): number[] {
  const t = Math.max(1e-6, temperature);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp((l - max) / t));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((e) => e / sum);
}

/** Confidence from the shape of the distribution: 1 - normalised entropy. */
function confidenceOf(probs: number[]): number {
  if (probs.length < 2) return 1;
  let h = 0;
  for (const p of probs) if (p > 0) h -= p * Math.log(p);
  return Math.min(1, Math.max(0, 1 - h / Math.log(probs.length)));
}

function targetUtility(t: TargetView, withIff: boolean, rand: () => number, noise: number): number {
  // Slew cost dominates: every degree away is time not spent shooting.
  let u = -t.angular_distance_deg * 0.09;
  u += Math.min(3, t.angular_size_deg) * 0.35;
  // Urgency: contacts about to leave are worth more.
  u += Math.max(0, 2500 - t.expires_in_ms) / 700;
  u -= t.speed_deg_s * 0.04;
  if (t.locked) u += 0.5;
  if (withIff) {
    const p = logistic(hostilityLogit(t.desc));
    u += (p - 0.5) * 10;
  }
  return u + (rand() - 0.5) * 2.2 * noise;
}

function isSnapshot(value: unknown): value is Snapshot {
  return !!value && typeof value === 'object' && Array.isArray((value as Snapshot).targets);
}

function answerFor(
  question: SystemOneRequest['questions'][string],
  snapshot: Snapshot | null,
  rand: () => number,
  noise: number,
): Answer {
  const withIff = snapshot ? modeHasIff(snapshot.mode) : false;

  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const logits = options.map((id) => {
      if (id === HOLD) {
        if (!snapshot) return 0;
        const anyWorth = snapshot.targets.some((t) => !withIff || logistic(hostilityLogit(t.desc)) > 0.5);
        return anyWorth ? -4.5 : 1.5;
      }
      const t = snapshot?.targets.find((x) => x.id === id);
      return t ? targetUtility(t, withIff, rand, noise) : -6;
    });
    const probs = softmax(logits, 2);
    const probabilities: Record<string, number> = {};
    options.forEach((id, i) => (probabilities[id] = round4(probs[i]!)));
    let bestIdx = 0;
    probs.forEach((p, i) => {
      if (p > probs[bestIdx]!) bestIdx = i;
    });
    return {
      type: 'choice',
      choice: options[bestIdx]!,
      probabilities,
      confidence: round4(confidenceOf(probs)),
    };
  }

  if (question.type === 'noul') {
    const locked = snapshot?.locked_target ?? null;
    if (!locked) return { type: 'noul', noul: round4(0.02 + rand() * 0.03) };
    if (!withIff) {
      // No IFF in this mode: anything still on the board is fair game.
      return { type: 'noul', noul: round4(0.93 + rand() * 0.06) };
    }
    const p = logistic(hostilityLogit(locked.desc) + (rand() - 0.5) * 1.6 * noise);
    return { type: 'noul', noul: round4(Math.min(0.995, Math.max(0.005, p))) };
  }

  // score (tempo)
  const levels = question.criteria.length || TEMPO_LEVELS.length;
  let ideal = 1;
  if (snapshot) {
    const live = snapshot.targets.length;
    const soonest = snapshot.targets.reduce((m, t) => Math.min(m, t.expires_in_ms), Infinity);
    ideal = 0;
    if (live >= 3) ideal += 1;
    if (live >= 6) ideal += 0.6;
    if (soonest < 1200) ideal += 1.1;
    if (snapshot.time_left_ms < 10000) ideal += 0.5;
  }
  ideal = Math.min(levels - 1, Math.max(0, ideal + (rand() - 0.5) * noise));
  const logits = Array.from({ length: levels }, (_, i) => -Math.abs(i - ideal) * 1.9);
  const probs = softmax(logits, 0.8);
  const probabilities: Record<string, number> = {};
  const legend: Record<string, string> = {};
  probs.forEach((p, i) => {
    probabilities[String(i)] = round4(p);
    legend[String(i)] = String(question.criteria[i] ?? '');
  });
  const score = probs.reduce((acc, p, i) => acc + p * i, 0);
  return { type: 'score', score: round4(score), legend, probabilities, confidence: round4(confidenceOf(probs)) };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Estimated tokens, so the HUD's cost readout is honest about being an estimate. */
export function estimateInputTokens(req: SystemOneRequest): number {
  return Math.ceil(JSON.stringify(req).length / 3.8);
}

export async function simulateSystemOne(req: SystemOneRequest, opts: SimOptions = {}): Promise<SystemOneResponse> {
  const { minLatencyMs = 70, maxLatencyMs = 500, noise = 0.35, delay = true } = opts;
  const rand = mulberry32(opts.seed ?? (Math.random() * 2 ** 32) >>> 0);

  if (delay) {
    // Skewed toward the fast end, like a real serving tail.
    const u = rand();
    const ms = minLatencyMs + (maxLatencyMs - minLatencyMs) * u * u;
    await new Promise((r) => setTimeout(r, ms));
  }

  const snapshot = isSnapshot(req.state) ? req.state : null;
  const answers: Record<string, Answer> = {};
  for (const [name, question] of Object.entries(req.questions)) {
    answers[name] = answerFor(question, snapshot, rand, noise);
  }

  return {
    model: SIM_MODEL,
    answers,
    usage: {
      input_tokens: estimateInputTokens(req),
      output_tokens: Object.keys(req.questions).length * 12,
    },
  };
}
