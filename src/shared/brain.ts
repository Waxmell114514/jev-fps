/**
 * The Jev brain: turns a game snapshot into a System One request, and a System
 * One response back into an aim command.
 *
 * Design rule, straight out of https://docs.typesafe.ai/concepts/how-to-build-with-system-one:
 * code stays in control of the continuous parts (slewing the sight, hit
 * detection, timing) and Jev only answers narrow, typed questions:
 *
 *   target  (choice) -- which contact to engage next
 *   engage  (noul)   -- is the contact under the crosshair a legitimate kill
 *   tempo   (score)  -- how hard to push the sight right now
 *
 * All three ride in a single call (speculative fan-out), so one round trip
 * produces a whole aim command.
 */

import type { Decision, FireVerdict, Policy, Snapshot, TargetView, DecisionSource } from './protocol.js';
import { DEFAULT_POLICY } from './protocol.js';
import type { ChoiceAnswer, JsonValue, NoulAnswer, ScoreAnswer, SystemOneRequest, SystemOneResponse } from './typesafe.js';

export const HOLD = 'hold';

export const TEMPO_LEVELS: string[] = [
  'Deliberate: few contacts and time to spare. Settle the sight and take a certain shot.',
  'Measured: the normal engagement pace. Move on, shoot when the sight is on.',
  'Fast: several contacts and the clock is against you. Snap on and fire as the sight crosses.',
  'Overrun: more contacts than time. Slew at maximum and accept overshoot and wasted rounds.',
];

/** Slew-rate multiplier and shot tolerance per tempo level. */
export const TEMPO_PROFILE: { slew: number; tolerance: number }[] = [
  { slew: 0.6, tolerance: 0.4 },
  { slew: 1.0, tolerance: 0.62 },
  { slew: 1.5, tolerance: 0.82 },
  { slew: 2.1, tolerance: 0.96 },
];

export const ROLE =
  'You are the targeting brain of a fixed-position defence gun. The gun cannot move or take cover; it can only rotate its sight and fire.';

/**
 * What separates a combatant from a protected craft. Exported so the rubric can
 * be evaluated on its own against the contact set -- see scripts/iff-probe.mjs.
 */
export const ENGAGE_CRITERIA = {
  true: 'It carries a working weapon or is attacking. A medical or civilian hull with a gun on it still counts; markings do not make it safe.',
  false:
    'It is unarmed and not attacking -- medical, civilian, relief or friendly, or a hull whose weapons have been removed. A warlike hull does not make it a target.',
} as const;

export const ENGAGE_QUESTION = 'The contact under the crosshair right now should be destroyed.';

function offsetPhrase(t: TargetView): string {
  const lr = t.yaw_deg >= 0 ? 'right' : 'left';
  const ud = t.pitch_deg >= 0 ? 'up' : 'down';
  return `${lr} ${Math.abs(t.yaw_deg).toFixed(1)}deg, ${ud} ${Math.abs(t.pitch_deg).toFixed(1)}deg`;
}

/** One Choice option: structured, not prose. See /primitives/advanced. */
function targetCriterion(t: TargetView, withIff: boolean): JsonValue {
  const entry: Record<string, JsonValue> = {
    offset_from_crosshair: offsetPhrase(t),
    slew_distance_deg: round(t.angular_distance_deg, 1),
    apparent_size_deg: round(t.angular_size_deg, 2),
    range_m: round(t.distance_m, 1),
    drift_deg_s: round(t.speed_deg_s, 1),
    leaves_in_ms: Math.round(t.expires_in_ms),
  };
  if (withIff) entry['seen_through_the_sight'] = t.desc;
  if (t.locked) entry['note'] = 'the sight is already on this contact';
  return entry;
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/** True for modes where contacts must be identified before being shot. */
export function modeHasIff(mode: Snapshot['mode']): boolean {
  return mode === 'triage';
}

export function buildRequest(snapshot: Snapshot, model: string): SystemOneRequest {
  const withIff = modeHasIff(snapshot.mode);

  const criteria: Record<string, JsonValue> = {};
  for (const t of snapshot.targets) criteria[t.id] = targetCriterion(t, withIff);
  criteria[HOLD] = withIff
    ? 'Nothing on the board is a legitimate target. Keep the sight still and shoot nothing.'
    : 'Nothing is worth a shot right now. Keep the sight still.';

  const prefer: string[] = [
    'a contact that is about to leave (small leaves_in_ms) over one that will stay',
    'a contact close to the crosshair over a far one, because every degree of slew costs time',
    'a large, slow contact over a small, fast one when nothing else separates them',
  ];
  if (withIff) prefer.unshift('a contact that is unambiguously hostile over one that might not be');

  const choiceInstructions: Record<string, JsonValue> = {
    role: ROLE,
    task: 'Pick the one contact the gun should slew onto and destroy next.',
    prefer,
    timing: `The sight slews at about ${Math.round(snapshot.crosshair.slew_deg_s)} degrees per second, so a contact 20deg away takes roughly ${Math.round((20 / Math.max(1, snapshot.crosshair.slew_deg_s)) * 1000)} ms to reach.`,
  };
  if (withIff) {
    choiceInstructions['rules_of_engagement'] = [
      'What a contact carries and what it is doing decides whether it is a combatant. Markings, hull type and paint do not.',
      'A medical or civilian craft with a working weapon on it is a combatant. A warship with its weapons cut away, carrying wounded, is not.',
      'Destroying a non-combatant is far worse than letting a hostile escape.',
    ];
  }

  const locked = snapshot.locked_target;
  const engageInstructions: Record<string, JsonValue> = {
    role: ROLE,
    question: ENGAGE_QUESTION,
    contact: locked
      ? {
          id: locked.id,
          seen_through_the_sight: withIff ? locked.desc : 'no identification available in this mode',
          crosshair_error_deg: round(snapshot.crosshair.error_deg, 2),
          leaves_in_ms: Math.round(locked.expires_in_ms),
        }
      : 'the sight is not on any contact',
    consequence: 'The gun fires the moment this comes back positive, so answer for this contact only.',
  };

  const questions: SystemOneRequest['questions'] = {
    target: {
      type: 'choice',
      instructions: choiceInstructions,
      criteria,
    },
    engage: {
      type: 'noul',
      instructions: engageInstructions,
      criteria: withIff
        ? { ...ENGAGE_CRITERIA }
        : {
            true: 'A live contact worth the round.',
            false: 'The sight is not on anything worth shooting.',
          },
    },
    tempo: {
      type: 'score',
      instructions: {
        role: ROLE,
        task: 'Rate how hard the gunner should push the sight right now, given how many contacts are up and how long they have left.',
      },
      criteria: TEMPO_LEVELS as unknown as JsonValue[],
    },
  };

  return { state: snapshot as unknown as JsonValue, model, questions };
}

/** Deterministic priority used when Jev's answer is too uncertain to trust. */
export function codeFallbackTarget(snapshot: Snapshot): string | null {
  let best: TargetView | null = null;
  let bestScore = -Infinity;
  for (const t of snapshot.targets) {
    // Cheap, boring heuristic: near the crosshair, big, and about to leave.
    const score = -t.angular_distance_deg * 1.5 + t.angular_size_deg * 4 + Math.max(0, 3000 - t.expires_in_ms) / 120;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best ? best.id : null;
}

export interface InterpretMeta {
  source: DecisionSource;
  latencyMs: number;
  snapshotAt: number;
}

function asChoice(a: unknown): ChoiceAnswer | null {
  return a && (a as ChoiceAnswer).type === 'choice' ? (a as ChoiceAnswer) : null;
}
function asNoul(a: unknown): NoulAnswer | null {
  return a && (a as NoulAnswer).type === 'noul' ? (a as NoulAnswer) : null;
}
function asScore(a: unknown): ScoreAnswer | null {
  return a && (a as ScoreAnswer).type === 'score' ? (a as ScoreAnswer) : null;
}

/**
 * Turn typed answers into an aim command. Every threshold is applied here, in
 * code -- Jev reports probabilities, the policy decides what to do with them.
 */
export function interpret(
  snapshot: Snapshot,
  response: SystemOneResponse,
  meta: InterpretMeta,
  policyInput: Partial<Policy> = {},
): Decision {
  const policy: Policy = { ...DEFAULT_POLICY, ...policyInput };

  const choice = asChoice(response.answers['target']);
  const noul = asNoul(response.answers['engage']);
  const score = asScore(response.answers['tempo']);

  const probabilities = choice ? { ...choice.probabilities } : {};
  const confidence = choice ? choice.confidence : 0;

  const notes: string[] = [];
  let targetId: string | null = null;
  let fallback = false;

  if (!choice) {
    notes.push('no target answer; using code fallback');
    fallback = true;
    targetId = codeFallbackTarget(snapshot);
  } else if (confidence < policy.minConfidence) {
    notes.push(`confidence ${confidence.toFixed(2)} < ${policy.minConfidence}; using code fallback`);
    fallback = true;
    targetId = codeFallbackTarget(snapshot);
  } else if (choice.choice === HOLD) {
    targetId = null;
  } else if (snapshot.targets.some((t) => t.id === choice.choice)) {
    targetId = choice.choice;
  } else {
    notes.push(`chose ${choice.choice}, which is no longer on the board`);
    fallback = true;
    targetId = codeFallbackTarget(snapshot);
  }

  const engage = noul ? clamp01(noul.noul) : 0;
  let fire: FireVerdict;
  if (!snapshot.locked_target) fire = 'hold';
  else if (engage >= policy.fireThreshold) fire = 'fire';
  else if (engage <= policy.holdThreshold) fire = 'hold';
  else fire = 'unsure';

  const levels = TEMPO_LEVELS.length;
  const tempoRaw = score ? score.score : 1;
  const tempo = Math.min(levels - 1, Math.max(0, tempoRaw));
  const tempoLabel = (TEMPO_LEVELS[Math.round(tempo)] ?? '').split(':')[0] ?? 'Measured';

  return {
    targetId,
    probabilities,
    confidence,
    fallback,
    engage,
    fire,
    engageTargetId: snapshot.locked_target ? snapshot.locked_target.id : null,
    tempo,
    tempoLabel,
    tempoConfidence: score ? score.confidence : 0,
    model: response.model,
    source: meta.source,
    latencyMs: meta.latencyMs,
    usage: response.usage,
    snapshotAt: meta.snapshotAt,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Slew multiplier and shot tolerance for a (possibly fractional) tempo score. */
export function tempoProfile(tempo: number): { slew: number; tolerance: number } {
  const lo = Math.floor(tempo);
  const hi = Math.min(TEMPO_PROFILE.length - 1, lo + 1);
  const f = tempo - lo;
  const a = TEMPO_PROFILE[Math.max(0, Math.min(TEMPO_PROFILE.length - 1, lo))]!;
  const b = TEMPO_PROFILE[hi]!;
  return { slew: a.slew + (b.slew - a.slew) * f, tolerance: a.tolerance + (b.tolerance - a.tolerance) * f };
}
