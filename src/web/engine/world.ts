/**
 * The range: contacts, the clock, hit detection and the scoreboard.
 *
 * The gun is bolted to the origin. It only rotates. Everything here is plain
 * simulation -- no model involvement, so a human and Jev play the same game.
 */

import type { GameMode, Snapshot, TargetKind, TargetView } from '../../shared/protocol.js';
import { pickContact } from './contacts.js';
import {
  DEG,
  RAD,
  angleBetween,
  anglesFromDir,
  type Camera,
  type Vec3,
  dirFromAngles,
  length,
  normalize,
  rotateAround,
  scale,
  sub,
  wrapAngle,
} from './math.js';

export interface Target {
  /** Stable identity. Display ids (A..H) are recycled; this never is. */
  uid: number;
  id: string;
  kind: TargetKind;
  desc: string;
  pos: Vec3;
  radius: number;
  bornAt: number;
  lifeMs: number;
  /** Rotation axis + rate for drifting contacts. */
  axis: Vec3 | null;
  angSpeed: number;
  dead: boolean;
  /** Set when killed, for the fade-out. */
  killedAt: number;
  hitFlash: number;
}

export interface ModeConfig {
  label: string;
  blurb: string;
  maxTargets: number;
  lifeMs: [number, number];
  radius: [number, number];
  distance: [number, number];
  drift: [number, number];
  iff: boolean;
}

export const MODES: Record<GameMode, ModeConfig> = {
  gridshot: {
    label: 'GRIDSHOT',
    blurb: 'Every contact is hostile. Pure speed: who can clear the board fastest.',
    maxTargets: 6,
    lifeMs: [3200, 4200],
    radius: [0.38, 0.56],
    distance: [13, 21],
    drift: [0, 0],
    iff: false,
  },
  triage: {
    label: 'IFF TRIAGE',
    blurb: 'Hostiles and protected craft, mixed. Read the contact before you shoot it.',
    maxTargets: 5,
    lifeMs: [5200, 7000],
    radius: [0.45, 0.62],
    distance: [13, 19],
    drift: [0, 0],
    iff: true,
  },
  drift: {
    label: 'DRIFT',
    blurb: 'Hostiles only, but they move. The sight has to lead them.',
    maxTargets: 5,
    lifeMs: [5000, 6500],
    radius: [0.4, 0.58],
    distance: [14, 21],
    drift: [0.1, 0.3],
    iff: false,
  },
};

export const RULES: Record<GameMode, string> = {
  gridshot: 'Every contact is hostile. Destroy as many as possible before the clock runs out.',
  triage:
    'Contacts are mixed. Destroying a hostile scores; destroying a protected craft costs far more than letting a hostile escape. Letting a protected craft leave untouched is the correct outcome.',
  drift: 'Every contact is hostile and moving. Destroy as many as possible before the clock runs out.',
};

export interface Stats {
  points: number;
  shots: number;
  hits: number;
  kills: number;
  friendlyFire: number;
  escaped: number;
  restraint: number;
  ttkMs: number[];
}

export interface ShotResult {
  hit: Target | null;
  origin: Vec3;
  /** Where the round went, for the tracer. */
  end: Vec3;
  friendlyFire: boolean;
  /** Points this shot was worth, for the floating number. */
  points: number;
}

const IDS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

function rand(lo: number, hi: number, r: () => number): number {
  return lo + (hi - lo) * r();
}

export class World {
  mode: GameMode;
  config: ModeConfig;
  targets: Target[] = [];
  stats: Stats = emptyStats();
  events: string[] = [];
  timeLeftMs: number;
  readonly roundMs: number;
  running = false;
  elapsedMs = 0;
  private rng: () => number;
  private spawnCooldown = 0;
  private uidCounter = 0;

  constructor(mode: GameMode, roundMs = 60_000, rng: () => number = Math.random) {
    this.mode = mode;
    this.config = MODES[mode];
    this.roundMs = roundMs;
    this.timeLeftMs = roundMs;
    this.rng = rng;
  }

  reset(mode: GameMode = this.mode): void {
    this.mode = mode;
    this.config = MODES[mode];
    this.targets = [];
    this.stats = emptyStats();
    this.events = [];
    this.timeLeftMs = this.roundMs;
    this.elapsedMs = 0;
    this.spawnCooldown = 0;
    this.running = true;
  }

  private freeId(): string {
    const used = new Set(this.targets.filter((t) => !t.dead).map((t) => t.id));
    return IDS.find((id) => !used.has(id)) ?? IDS[0]!;
  }

  private spawn(now: number): void {
    const c = this.config;
    const yaw = rand(-48, 48, this.rng) * DEG;
    const pitch = rand(-16, 26, this.rng) * DEG;
    const dist = rand(c.distance[0], c.distance[1], this.rng);
    const pos = scale(dirFromAngles(yaw, pitch), dist);

    let kind: TargetKind = 'hostile';
    let desc = '';
    if (c.iff) {
      const contact = pickContact(this.rng);
      kind = contact.hostile ? 'hostile' : 'friendly';
      desc = contact.desc;
    }

    const drift = rand(c.drift[0], c.drift[1], this.rng);
    const axis =
      drift > 0
        ? normalize({ x: rand(-0.4, 0.4, this.rng), y: 1, z: rand(-0.4, 0.4, this.rng) })
        : null;

    this.targets.push({
      uid: ++this.uidCounter,
      id: this.freeId(),
      kind,
      desc,
      pos,
      radius: rand(c.radius[0], c.radius[1], this.rng),
      bornAt: now,
      lifeMs: rand(c.lifeMs[0], c.lifeMs[1], this.rng),
      axis,
      angSpeed: drift * (this.rng() < 0.5 ? -1 : 1),
      dead: false,
      killedAt: 0,
      hitFlash: 0,
    });
  }

  update(now: number, dtMs: number): void {
    if (!this.running) return;
    this.timeLeftMs = Math.max(0, this.timeLeftMs - dtMs);
    this.elapsedMs += dtMs;
    if (this.timeLeftMs <= 0) {
      this.running = false;
      this.pushEvent('round over');
      return;
    }

    const dt = dtMs / 1000;
    for (const t of this.targets) {
      if (t.dead) continue;
      if (t.axis && t.angSpeed) t.pos = rotateAround(t.pos, t.axis, t.angSpeed * dt);
      t.hitFlash = Math.max(0, t.hitFlash - dtMs);
      if (now - t.bornAt >= t.lifeMs) {
        t.dead = true;
        t.killedAt = now;
        if (t.kind === 'hostile') {
          this.stats.escaped++;
          this.stats.points -= 25;
          this.pushEvent(`${t.id} escaped`);
        } else {
          this.stats.restraint++;
          this.stats.points += 10;
          this.pushEvent(`${t.id} left unharmed`);
        }
      }
    }

    this.targets = this.targets.filter((t) => !t.dead || now - t.killedAt < 260);

    this.spawnCooldown -= dtMs;
    const live = this.live().length;
    if (live < this.config.maxTargets && this.spawnCooldown <= 0) {
      this.spawn(now);
      this.spawnCooldown = live === 0 ? 60 : 180;
    }
  }

  live(): Target[] {
    return this.targets.filter((t) => !t.dead);
  }

  byId(id: string | null): Target | null {
    if (!id) return null;
    return this.live().find((t) => t.id === id) ?? null;
  }

  byUid(uid: number | undefined): Target | null {
    if (uid === undefined) return null;
    return this.live().find((t) => t.uid === uid) ?? null;
  }

  /** Angular radius of a contact seen from the gun, in radians. */
  angularRadius(t: Target, cam: Camera): number {
    const d = Math.max(0.5, length(sub(t.pos, cam.pos)));
    return Math.asin(Math.min(0.999, t.radius / d));
  }

  /** Angle between the sight line and a contact, in radians. */
  aimError(t: Target, cam: Camera): number {
    return angleBetween(dirFromAngles(cam.yaw, cam.pitch), sub(t.pos, cam.pos));
  }

  /** The contact under the crosshair right now, if any. */
  underCrosshair(cam: Camera): Target | null {
    let best: Target | null = null;
    let bestDist = Infinity;
    for (const t of this.live()) {
      if (this.aimError(t, cam) <= this.angularRadius(t, cam)) {
        const d = length(sub(t.pos, cam.pos));
        if (d < bestDist) {
          bestDist = d;
          best = t;
        }
      }
    }
    return best;
  }

  shoot(cam: Camera, now: number): ShotResult {
    const forward = dirFromAngles(cam.yaw, cam.pitch);
    this.stats.shots++;
    const hit = this.underCrosshair(cam);
    const end = hit ? hit.pos : scale(forward, 60);

    if (!hit) {
      this.stats.points -= 15;
      this.pushEvent('miss');
      return { hit: null, origin: cam.pos, end, friendlyFire: false, points: -15 };
    }

    hit.dead = true;
    hit.killedAt = now;
    hit.hitFlash = 200;
    this.stats.hits++;

    if (hit.kind === 'friendly') {
      this.stats.friendlyFire++;
      this.stats.points -= 300;
      this.pushEvent(`FRIENDLY FIRE on ${hit.id}`);
      return { hit, origin: cam.pos, end, friendlyFire: true, points: -300 };
    }

    const ttk = now - hit.bornAt;
    this.stats.kills++;
    this.stats.ttkMs.push(ttk);
    const points = 100 + Math.round(Math.max(0, 1 - ttk / 2500) * 50);
    this.stats.points += points;
    this.pushEvent(`killed ${hit.id}`);
    return { hit, origin: cam.pos, end, friendlyFire: false, points };
  }

  pushEvent(line: string): void {
    this.events.push(line);
    if (this.events.length > 8) this.events.shift();
  }

  accuracyPct(): number {
    return this.stats.shots ? Math.round((this.stats.hits / this.stats.shots) * 100) : 0;
  }

  avgTtkMs(): number {
    const list = this.stats.ttkMs;
    if (!list.length) return 0;
    return Math.round(list.reduce((a, b) => a + b, 0) / list.length);
  }

  /** The JSON handed to Jev as `state`. */
  snapshot(cam: Camera, now: number, lockedId: string | null, slewDegS: number): Snapshot {
    const view = (t: Target): TargetView => {
      const rel = sub(t.pos, cam.pos);
      const a = anglesFromDir(rel);
      const dist = length(rel);
      return {
        id: t.id,
        desc: t.desc,
        yaw_deg: round(wrapAngle(a.yaw - cam.yaw) * RAD * -1, 1),
        pitch_deg: round((a.pitch - cam.pitch) * RAD, 1),
        angular_distance_deg: round(this.aimError(t, cam) * RAD, 1),
        angular_size_deg: round(this.angularRadius(t, cam) * 2 * RAD, 2),
        distance_m: round(dist, 1),
        speed_deg_s: round(Math.abs(t.angSpeed) * RAD, 1),
        expires_in_ms: Math.max(0, Math.round(t.lifeMs - (now - t.bornAt))),
        locked: t.id === lockedId,
      };
    };

    const locked = this.byId(lockedId);
    const under = this.underCrosshair(cam);
    const errorTarget = locked ?? under;

    return {
      mode: this.mode,
      rules: RULES[this.mode],
      time_left_ms: Math.round(this.timeLeftMs),
      crosshair: {
        on_target: under ? under.id : null,
        error_deg: errorTarget ? round(this.aimError(errorTarget, cam) * RAD, 2) : 0,
        slew_deg_s: Math.round(slewDegS),
      },
      locked_target: locked ? view(locked) : null,
      targets: this.live().map(view),
      score: {
        points: this.stats.points,
        kills: this.stats.kills,
        misses: this.stats.shots - this.stats.hits,
        friendly_fire: this.stats.friendlyFire,
        accuracy_pct: this.accuracyPct(),
      },
      recent_events: this.events.slice(-5),
    };
  }
}

function round(n: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function emptyStats(): Stats {
  return { points: 0, shots: 0, hits: 0, kills: 0, friendlyFire: 0, escaped: 0, restraint: 0, ttkMs: [] };
}
