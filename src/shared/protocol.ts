/** Types exchanged between the game loop, the server, and the Jev brain. */

import type { SystemOneRequest, SystemOneResponse, Usage } from './typesafe.js';

export type GameMode = 'gridshot' | 'triage' | 'drift';

export type TargetKind = 'hostile' | 'friendly';

/** One target as the gunner sees it. Angles are relative to the crosshair. */
export interface TargetView {
  /** Short, stable label used as the Choice option key (A, B, C ...). */
  id: string;
  /** What the gunner can make out through the sight. Empty in modes without IFF. */
  desc: string;
  /** Positive = right of crosshair. */
  yaw_deg: number;
  /** Positive = above crosshair. */
  pitch_deg: number;
  /** Great-circle angle between the crosshair and the target centre. */
  angular_distance_deg: number;
  /** Apparent diameter. Bigger = easier shot. */
  angular_size_deg: number;
  distance_m: number;
  /** Apparent lateral speed, degrees per second. */
  speed_deg_s: number;
  /** Milliseconds before the target leaves. */
  expires_in_ms: number;
  /** True when this is the target the gunner is currently slewing onto. */
  locked: boolean;
}

/** The world state handed to Jev as `state`. Plain JSON, no prose. */
export interface Snapshot {
  mode: GameMode;
  rules: string;
  time_left_ms: number;
  crosshair: {
    /** Target id under the crosshair right now, or null. */
    on_target: string | null;
    /** Angular error to the locked target, degrees. */
    error_deg: number;
    /** Degrees per second the sight can slew at the current tempo. */
    slew_deg_s: number;
  };
  /** The target the gunner is about to shoot. `engage` is asked about this one. */
  locked_target: TargetView | null;
  targets: TargetView[];
  score: {
    points: number;
    kills: number;
    misses: number;
    friendly_fire: number;
    accuracy_pct: number;
  };
  /** Newest last. Short factual lines, e.g. "hit B", "friendly fire on D". */
  recent_events: string[];
}

/** Tunables the operator can move at runtime; all gating lives in code. */
export interface Policy {
  /** noul >= this -> pull the trigger */
  fireThreshold: number;
  /** noul <= this -> positively identified as not-a-target */
  holdThreshold: number;
  /** choice confidence below this -> ignore Jev, use the code fallback */
  minConfidence: number;
}

export const DEFAULT_POLICY: Policy = {
  fireThreshold: 0.75,
  holdThreshold: 0.4,
  minConfidence: 0.2,
};

export type FireVerdict = 'fire' | 'hold' | 'unsure';

export type DecisionSource = 'jev' | 'simulator';

/** Everything the aim controller needs, plus everything the HUD wants to show. */
export interface Decision {
  /** Chosen target id, or null for "hold" (nothing worth engaging). */
  targetId: string | null;
  /** Full distribution over the options Jev was given, including "hold". */
  probabilities: Record<string, number>;
  /** Jev's certainty in the target choice. */
  confidence: number;
  /** True when confidence was too low and code picked the target instead. */
  fallback: boolean;
  /** Probability that the locked target is a legitimate hostile. */
  engage: number;
  /** Which way the trigger gate resolved, after thresholds. */
  fire: FireVerdict;
  /** Id `engage` was asked about; the trigger only unlocks for this target. */
  engageTargetId: string | null;
  /** 0..n-1 across the tempo rubric. Drives slew rate and shot tolerance. */
  tempo: number;
  tempoLabel: string;
  tempoConfidence: number;
  model: string;
  source: DecisionSource;
  /** Round-trip time of the System One call, milliseconds. */
  latencyMs: number;
  usage: Usage;
  /** performance.now() when the snapshot was taken. */
  snapshotAt: number;
  note?: string;
}

/** What /api/decide returns: the decision plus the raw call, for the HUD. */
export interface DecideResult {
  decision: Decision;
  request: SystemOneRequest;
  response: SystemOneResponse;
}

export interface DecideBody {
  snapshot: Snapshot;
  policy?: Partial<Policy>;
  snapshotAt?: number;
}

export interface HealthInfo {
  /** 'jev' when a TYPESAFE_API_KEY is configured, otherwise 'simulator'. */
  source: DecisionSource;
  model: string;
  version: string;
}
