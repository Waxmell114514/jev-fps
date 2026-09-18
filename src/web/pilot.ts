/**
 * The Jev pilot.
 *
 * Split of responsibility (https://docs.typesafe.ai/concepts/how-to-build-with-system-one):
 *
 *   Jev decides   -- which contact to engage, whether the contact under the
 *                    crosshair may be shot, how hard to push the sight.
 *   Code decides  -- everything continuous and everything with a deadline:
 *                    the slew curve, when the sight is on, rate of fire,
 *                    what to do while a decision is still in flight.
 *
 * One System One call carries all three answers, so a single round trip
 * (70-500 ms on the real model) produces a complete aim command. The gun never
 * stalls waiting for one: it keeps executing the last command until the next
 * lands.
 *
 * Trigger clearances are keyed to a contact's uid, not its display letter --
 * letters are recycled as contacts come and go, and a refusal must not outlive
 * the contact it was about.
 */

import { modeHasIff, tempoProfile } from '../shared/brain.js';
import type { Decision, DecideResult, FireVerdict, Policy, Snapshot } from '../shared/protocol.js';
import { DEFAULT_POLICY } from '../shared/protocol.js';
import type { SystemOneRequest, SystemOneResponse } from '../shared/typesafe.js';
import { DEG, RAD, anglesFromDir, type Camera, clamp, sub, wrapAngle } from './engine/math.js';
import type { Target, World, ShotResult } from './engine/world.js';
import type { JevLink } from './link.js';

export interface PilotConfig {
  /** Minimum gap between System One calls, milliseconds. */
  decisionIntervalMs: number;
  /** Sight slew rate at tempo 1, degrees per second. */
  baseSlewDegS: number;
  /** Minimum gap between rounds, milliseconds. */
  fireIntervalMs: number;
  /** How long an "unsure" contact is left alone before it is looked at again. */
  unsureCooldownMs: number;
  policy: Policy;
}

export const DEFAULT_PILOT_CONFIG: PilotConfig = {
  decisionIntervalMs: 90,
  baseSlewDegS: 520,
  fireIntervalMs: 110,
  unsureCooldownMs: 1500,
  policy: { ...DEFAULT_POLICY },
};

export interface CallRecord {
  at: number;
  latencyMs: number;
  targetId: string | null;
  confidence: number;
  engage: number;
  fire: FireVerdict;
  tempo: number;
  source: Decision['source'];
  inputTokens: number;
  /** The contact the call was about was gone by the time the answer landed. */
  stale: boolean;
}

interface Clearance {
  verdict: FireVerdict;
  asks: number;
  /** When the verdict was recorded, for the "unsure" cooldown. */
  at: number;
}

export class JevPilot {
  config: PilotConfig = { ...DEFAULT_PILOT_CONFIG, policy: { ...DEFAULT_POLICY } };
  lockedId: string | null = null;
  decision: Decision | null = null;
  lastRequest: SystemOneRequest | null = null;
  lastResponse: SystemOneResponse | null = null;
  history: CallRecord[] = [];
  log: string[] = [];

  inFlight = false;
  callsStarted = 0;
  callsLanded = 0;
  staleCalls = 0;
  withheld = 0;
  fallbacks = 0;
  inputTokens = 0;

  /** uid -> what the engage noul said about that contact. */
  private clearance = new Map<number, Clearance>();
  private lockedUid: number | null = null;
  private nextDecisionAt = 0;
  private lastShotAt = 0;
  private slewDegS = DEFAULT_PILOT_CONFIG.baseSlewDegS;
  private tolerance = 0.7;
  private now = 0;

  constructor(private link: JevLink) {}

  reset(): void {
    this.lockedId = null;
    this.lockedUid = null;
    this.decision = null;
    this.lastRequest = null;
    this.lastResponse = null;
    this.history = [];
    this.log = [];
    this.inFlight = false;
    this.callsStarted = 0;
    this.callsLanded = 0;
    this.staleCalls = 0;
    this.withheld = 0;
    this.fallbacks = 0;
    this.inputTokens = 0;
    this.clearance.clear();
    this.nextDecisionAt = 0;
    this.lastShotAt = 0;
  }

  get slewRate(): number {
    return this.slewDegS;
  }

  /** True when the trigger is currently open for the locked contact. */
  get cleared(): boolean {
    return this.lockedUid !== null && this.clearance.get(this.lockedUid)?.verdict === 'fire';
  }

  private note(line: string): void {
    this.log.push(line);
    if (this.log.length > 40) this.log.shift();
  }

  /** One frame of the pilot: think if it is time, then aim, then maybe shoot. */
  update(world: World, cam: Camera, now: number, dtMs: number, onShot: (r: ShotResult) => void): void {
    if (!world.running) return;
    this.now = now;
    this.maybeThink(world, cam, now);
    this.chooseLockIfNeeded(world, now);
    this.aim(world, cam, dtMs);
    this.maybeFire(world, cam, now, onShot);
  }

  /**
   * A contact the trigger gate has ruled out. A confident "no" sticks for the
   * contact's life; an uncertain one only parks it, so the sight comes back to
   * it with a fresh look instead of writing it off.
   */
  private blocked(t: Target): boolean {
    const c = this.clearance.get(t.uid);
    if (!c) return false;
    if (c.verdict === 'hold') return true;
    return c.verdict === 'unsure' && this.now - c.at < this.config.unsureCooldownMs;
  }

  private maybeThink(world: World, cam: Camera, now: number): void {
    if (this.inFlight || now < this.nextDecisionAt) return;
    const snapshot = world.snapshot(cam, now, this.lockedId, this.slewDegS);
    if (!snapshot.targets.length) {
      this.nextDecisionAt = now + 60;
      return;
    }

    // Display letters are recycled, so remember which contact each letter meant
    // when the question was asked.
    const uids = new Map(world.live().map((t) => [t.id, t.uid]));

    this.inFlight = true;
    this.callsStarted++;
    const startedAt = now;

    void this.link
      .decide(snapshot, this.config.policy, startedAt)
      .then((result) => this.land(result, snapshot, world, uids))
      .catch((err: unknown) => this.note(`call failed: ${String(err)}`))
      .finally(() => {
        this.inFlight = false;
        this.nextDecisionAt = performance.now() + this.config.decisionIntervalMs;
      });
  }

  /** Apply a decision that has just come back. */
  private land(result: DecideResult, snapshot: Snapshot, world: World, uids: Map<string, number>): void {
    const d = result.decision;
    this.decision = d;
    this.lastRequest = result.request;
    this.lastResponse = result.response;
    this.callsLanded++;
    this.inputTokens += d.usage.input_tokens;
    if (d.fallback) this.fallbacks++;

    // Did the contact we asked about survive the round trip?
    const engageUid = d.engageTargetId ? uids.get(d.engageTargetId) : undefined;
    const engageTarget = world.byUid(engageUid);
    const stale = !!d.engageTargetId && !engageTarget;
    if (stale) this.staleCalls++;

    if (engageTarget && engageUid !== undefined) {
      const previous = this.clearance.get(engageUid);
      this.clearance.set(engageUid, { verdict: d.fire, asks: (previous?.asks ?? 0) + 1, at: this.now });
      if (d.fire !== 'fire' && previous?.verdict !== d.fire) {
        this.withheld++;
        const seen = snapshot.locked_target?.desc;
        this.note(
          d.fire === 'unsure'
            ? `${d.engageTargetId} unsure (${d.engage.toFixed(2)}) -- trigger stays shut`
            : `${d.engageTargetId} not a target (${d.engage.toFixed(2)})${seen ? `: ${short(seen)}` : ''}`,
        );
      }
    }

    const profile = tempoProfile(d.tempo);
    this.slewDegS = this.config.baseSlewDegS * profile.slew;
    this.tolerance = profile.tolerance;

    const wanted = d.targetId ? world.byId(d.targetId) : null;
    if (wanted && !this.blocked(wanted)) {
      if (wanted.uid !== this.lockedUid) {
        this.note(`slew to ${wanted.id} (p=${(d.probabilities[wanted.id] ?? 0).toFixed(2)})`);
      }
      this.lock(wanted);
    } else if (wanted) {
      // Jev picked a contact the trigger gate has already ruled out; take the
      // next best live one rather than parking the sight on it.
      this.lock(this.bestAlternative(world, d));
    } else if (!d.targetId) {
      this.lock(null);
    }

    this.prune(world);

    this.history.push({
      at: d.snapshotAt,
      latencyMs: d.latencyMs,
      targetId: d.targetId,
      confidence: d.confidence,
      engage: d.engage,
      fire: d.fire,
      tempo: d.tempo,
      source: d.source,
      inputTokens: d.usage.input_tokens,
      stale,
    });
    if (this.history.length > 120) this.history.shift();
    if (d.note) this.note(d.note);
  }

  private lock(t: Target | null): void {
    this.lockedId = t ? t.id : null;
    this.lockedUid = t ? t.uid : null;
  }

  /** Drop clearances for contacts that are gone, so the map cannot grow stale. */
  private prune(world: World): void {
    if (this.clearance.size < 24) return;
    const alive = new Set(world.live().map((t) => t.uid));
    for (const uid of [...this.clearance.keys()]) if (!alive.has(uid)) this.clearance.delete(uid);
  }

  private bestAlternative(world: World, d: Decision | null): Target | null {
    const live = world.live().filter((t) => !this.blocked(t));
    if (!live.length) return null;
    let best = live[0]!;
    let bestScore = -Infinity;
    for (const t of live) {
      // Jev's own ranking first; if it said nothing about this contact, fall
      // back to "near the crosshair and about to leave".
      const score = d ? (d.probabilities[t.id] ?? 0) : 0;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  /** Never leave the sight idle while a decision is in flight. */
  private chooseLockIfNeeded(world: World, now: number): void {
    const current = world.byUid(this.lockedUid ?? undefined);
    if (current && !this.blocked(current)) return;

    const previousUid = this.lockedUid;
    this.lock(this.bestAlternative(world, this.decision));
    if (previousUid !== this.lockedUid) {
      // The board changed: ask again as soon as the rate limit allows.
      this.nextDecisionAt = Math.min(this.nextDecisionAt, now + 10);
    }
  }

  private aim(world: World, cam: Camera, dtMs: number): void {
    const t = world.byUid(this.lockedUid ?? undefined);
    if (!t) return;
    const want = anglesFromDir(sub(t.pos, cam.pos));
    const dYaw = wrapAngle(want.yaw - cam.yaw);
    const dPitch = want.pitch - cam.pitch;

    const dt = dtMs / 1000;
    const maxStep = this.slewDegS * DEG * dt;
    // Proportional approach, rate limited: quick off the mark, settles clean.
    const gain = 1 - Math.exp(-11 * dt);
    cam.yaw += clamp(dYaw * gain, -maxStep, maxStep);
    cam.pitch += clamp(dPitch * gain, -maxStep, maxStep);
    cam.pitch = clamp(cam.pitch, -60 * DEG, 60 * DEG);
  }

  private maybeFire(world: World, cam: Camera, now: number, onShot: (r: ShotResult) => void): void {
    if (now - this.lastShotAt < this.config.fireIntervalMs) return;
    const t = world.byUid(this.lockedUid ?? undefined);
    if (!t) return;

    const under = world.underCrosshair(cam);
    if (!under || under.uid !== t.uid) {
      // Not on it yet; tempo decides how sloppy a shot we are willing to take.
      const err = world.aimError(t, cam) * RAD;
      const radius = world.angularRadius(t, cam) * RAD;
      if (err > radius * this.tolerance) return;
    }

    if (!this.triggerOpen(world, t)) return;

    this.lastShotAt = now;
    const result = world.shoot(cam, now);
    onShot(result);

    // Recoil: the sight is knocked off and has to settle again.
    cam.pitch += 0.4 * DEG;
    cam.yaw += (Math.random() - 0.5) * 0.25 * DEG;

    if (result.hit) {
      this.clearance.delete(result.hit.uid);
      this.lock(null);
      // A kill changes the board: think again immediately.
      this.nextDecisionAt = Math.min(this.nextDecisionAt, now + 10);
    }
  }

  /** The trigger only opens for a contact Jev has cleared. */
  private triggerOpen(world: World, t: Target): boolean {
    const verdict = this.clearance.get(t.uid)?.verdict;
    if (verdict === 'fire') return true;
    if (verdict) return false;
    // Nothing said about this contact yet. Where identification matters, wait
    // for an answer; where it does not, there is nothing to identify.
    return !modeHasIff(world.mode);
  }

  latencyPercentile(p: number): number {
    if (!this.history.length) return 0;
    const sorted = this.history.map((h) => h.latencyMs).sort((a, b) => a - b);
    const idx = clamp(Math.floor(sorted.length * p), 0, sorted.length - 1);
    return Math.round(sorted[idx]!);
  }
}

function short(text: string): string {
  return text.length > 44 ? `${text.slice(0, 41)}...` : text;
}
