/** Canvas renderer: perspective-projected range, contacts, weapon and effects. */

import type { Camera, Vec3, Viewport } from './math.js';
import { basisOf, dirFromAngles, project, projectSegment, scale, sub, vec, viewportFor } from './math.js';
import type { Target, World } from './world.js';

export interface Tracer {
  from: Vec3;
  to: Vec3;
  born: number;
}
export interface Marker {
  x: number;
  y: number;
  born: number;
  kind: 'hit' | 'kill' | 'foul';
}
export interface FloatText {
  world: Vec3;
  text: string;
  born: number;
  color: string;
}

export class Effects {
  tracers: Tracer[] = [];
  markers: Marker[] = [];
  texts: FloatText[] = [];
  shake = 0;
  muzzle = 0;
  recoil = 0;

  fire(now: number, from: Vec3, to: Vec3): void {
    this.tracers.push({ from, to, born: now });
    this.muzzle = 60;
    this.recoil = 1;
    this.shake = Math.min(8, this.shake + 3);
  }

  mark(kind: Marker['kind'], now: number): void {
    this.markers.push({ x: 0, y: 0, born: now, kind });
  }

  text(world: Vec3, text: string, color: string, now: number): void {
    this.texts.push({ world, text, born: now, color });
  }

  update(dtMs: number, now: number): void {
    this.muzzle = Math.max(0, this.muzzle - dtMs);
    this.shake = Math.max(0, this.shake - dtMs * 0.03);
    this.recoil = Math.max(0, this.recoil - dtMs / 260);
    this.tracers = this.tracers.filter((t) => now - t.born < 120);
    this.markers = this.markers.filter((m) => now - m.born < 420);
    this.texts = this.texts.filter((t) => now - t.born < 900);
  }
}

export interface RenderState {
  world: World;
  cam: Camera;
  now: number;
  effects: Effects;
  /** Last decision's distribution over contact ids, for the Jev overlay. */
  probabilities: Record<string, number>;
  lockedId: string | null;
  /** True when the trigger is currently held open by the engage gate. */
  cleared: boolean;
  showOverlay: boolean;
  pilot: 'human' | 'jev';
}

const C = {
  bg0: '#070a10',
  bg1: '#0d1420',
  grid: '#172436',
  gridFar: '#0f1a28',
  hostile: '#ff5f45',
  hostileDim: '#8a2a1e',
  friendly: '#3fd2ff',
  friendlyDim: '#175a73',
  accent: '#b98cff',
  text: '#cfe3f5',
  dim: '#7b8ea3',
};

const FLOOR_Y = -3;

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private canvas: HTMLCanvasElement;
  view: Viewport;
  hFovDeg = 100;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.view = viewportFor(canvas.width, canvas.height, this.hFovDeg);
  }

  resize(): void {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = Math.max(320, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(240, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.view = viewportFor(w, h, this.hFovDeg);
  }

  render(s: RenderState): void {
    const { ctx } = this;
    const basis = basisOf(s.cam);
    const shake = s.effects.shake;

    ctx.save();
    if (shake > 0.2) {
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }

    this.drawSky(s);
    this.drawFloor(s, basis);
    this.drawPylons(s, basis);

    const live = [...s.world.targets].sort((a, b) => depth(b, s) - depth(a, s));
    for (const t of live) this.drawTarget(t, s, basis);

    this.drawTracers(s, basis);
    this.drawFloatTexts(s, basis);
    this.drawWeapon(s);
    this.drawCrosshair(s);
    this.drawMarkers(s);

    ctx.restore();

    if (!s.world.running) this.drawIdleVeil();
    this.drawVignette();
  }

  private drawSky(s: RenderState): void {
    const { ctx, view } = this;
    const horizon = view.height / 2 + (view.focal * Math.tan(s.cam.pitch)) / 1;
    const g = ctx.createLinearGradient(0, 0, 0, view.height);
    g.addColorStop(0, C.bg0);
    g.addColorStop(0.55, C.bg1);
    g.addColorStop(1, '#060910');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.width, view.height);

    // Faint horizon glow so the range reads as a space, not a void.
    const hy = Math.max(-200, Math.min(view.height + 200, horizon));
    const hg = ctx.createLinearGradient(0, hy - view.height * 0.18, 0, hy + view.height * 0.1);
    hg.addColorStop(0, 'rgba(30,60,90,0)');
    hg.addColorStop(0.7, 'rgba(46,96,140,0.22)');
    hg.addColorStop(1, 'rgba(10,18,28,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(0, hy - view.height * 0.2, view.width, view.height * 0.32);
  }

  private drawFloor(s: RenderState, basis: ReturnType<typeof basisOf>): void {
    const { ctx, view } = this;
    ctx.lineWidth = Math.max(1, view.width / 1600);
    const step = 4;
    for (let x = -48; x <= 48; x += step) {
      const seg = projectSegment(vec(x, FLOOR_Y, 6), vec(x, FLOOR_Y, -70), s.cam, basis, view);
      if (!seg) continue;
      ctx.strokeStyle = x === 0 ? '#22384f' : C.grid;
      ctx.beginPath();
      ctx.moveTo(seg[0].x, seg[0].y);
      ctx.lineTo(seg[1].x, seg[1].y);
      ctx.stroke();
    }
    for (let z = 6; z >= -70; z -= step) {
      const seg = projectSegment(vec(-48, FLOOR_Y, z), vec(48, FLOOR_Y, z), s.cam, basis, view);
      if (!seg) continue;
      const fade = Math.max(0.08, 1 - Math.abs(z) / 80);
      ctx.strokeStyle = fade > 0.5 ? C.grid : C.gridFar;
      ctx.globalAlpha = fade;
      ctx.beginPath();
      ctx.moveTo(seg[0].x, seg[0].y);
      ctx.lineTo(seg[1].x, seg[1].y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawPylons(s: RenderState, basis: ReturnType<typeof basisOf>): void {
    const { ctx, view } = this;
    ctx.strokeStyle = '#1d2f44';
    ctx.lineWidth = Math.max(1, view.width / 1200);
    for (const x of [-30, -18, 18, 30]) {
      for (const z of [-34, -52]) {
        const seg = projectSegment(vec(x, FLOOR_Y, z), vec(x, FLOOR_Y + 9, z), s.cam, basis, view);
        if (!seg) continue;
        ctx.beginPath();
        ctx.moveTo(seg[0].x, seg[0].y);
        ctx.lineTo(seg[1].x, seg[1].y);
        ctx.stroke();
      }
    }
  }

  private drawTarget(t: Target, s: RenderState, basis: ReturnType<typeof basisOf>): void {
    const { ctx, view } = this;
    const p = project(t.pos, s.cam, basis, view);
    if (!p.visible) return;
    const r = Math.max(3, (view.focal * t.radius) / p.depth);
    if (p.x < -r * 6 || p.x > view.width + r * 6) return;

    const dying = t.dead;
    const fade = dying ? Math.max(0, 1 - (s.now - t.killedAt) / 260) : 1;
    const hostile = t.kind === 'hostile';
    const base = hostile ? C.hostile : C.friendly;
    const dim = hostile ? C.hostileDim : C.friendlyDim;

    ctx.save();
    ctx.globalAlpha = fade;

    if (dying) {
      // Burst ring on death.
      const k = 1 - fade;
      ctx.strokeStyle = base;
      ctx.globalAlpha = fade * 0.8;
      ctx.lineWidth = Math.max(1, r * 0.18 * fade);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r * (1 + k * 1.8), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const grad = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
    grad.addColorStop(0, hostile ? '#ffd2b0' : '#cdf4ff');
    grad.addColorStop(0.45, base);
    grad.addColorStop(1, dim);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.stroke();

    // Life ring: how long before it leaves.
    const life = 1 - (s.now - t.bornAt) / t.lifeMs;
    ctx.strokeStyle = life < 0.25 ? '#ffd34a' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = Math.max(1.4, r * 0.12);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 1.35, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, life));
    ctx.stroke();

    // Id chip.
    const fs = Math.max(9, Math.min(20, r * 0.9));
    ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(8,12,18,0.85)';
    ctx.fillText(t.id, p.x, p.y + fs * 0.05);

    // Contacts low on screen would have their label hidden behind the weapon,
    // so the label goes above them and the probability bar swaps below.
    const labelAbove = p.y > view.height * 0.6;
    if (s.showOverlay) this.drawTargetOverlay(t, p.x, p.y, r, s, labelAbove);
    if (t.desc) this.drawContactLabel(t, p.x, p.y, r, labelAbove);

    ctx.restore();
  }

  private drawTargetOverlay(t: Target, x: number, y: number, r: number, s: RenderState, below = false): void {
    const { ctx, view } = this;
    const prob = s.probabilities[t.id];
    const locked = s.lockedId === t.id;

    if (locked) {
      const b = r * 1.75;
      ctx.strokeStyle = s.cleared ? '#68ff9d' : C.accent;
      ctx.lineWidth = Math.max(1.5, view.width / 900);
      const arm = b * 0.45;
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as [number, number][]) {
        ctx.beginPath();
        ctx.moveTo(x + sx * b, y + sy * b - sy * arm);
        ctx.lineTo(x + sx * b, y + sy * b);
        ctx.lineTo(x + sx * b - sx * arm, y + sy * b);
        ctx.stroke();
      }
    }

    if (prob !== undefined && prob > 0.02) {
      const w = r * 2.4;
      const h = Math.max(3, r * 0.16);
      const bx = x - w / 2;
      const by = below ? y + r * 1.8 : y - r * 1.95;
      ctx.fillStyle = 'rgba(10,14,22,0.75)';
      ctx.fillRect(bx, by, w, h);
      ctx.fillStyle = C.accent;
      ctx.fillRect(bx, by, w * Math.min(1, prob), h);
      ctx.font = `600 ${Math.max(8, r * 0.42)}px ui-monospace, monospace`;
      ctx.fillStyle = C.accent;
      ctx.textAlign = 'center';
      ctx.fillText(`${Math.round(prob * 100)}%`, x, below ? by + h + Math.max(9, r * 0.5) : by - Math.max(4, r * 0.3));
    }
  }

  private drawContactLabel(t: Target, cx: number, cy: number, r: number, above: boolean): void {
    const { ctx, view } = this;
    const fs = Math.max(9, Math.min(13, view.width / 110));
    ctx.font = `400 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const words = t.desc.split(' ');
    const lines: string[] = [];
    let line = '';
    const maxChars = 30;
    for (const w of words) {
      if ((line + ' ' + w).trim().length > maxChars) {
        lines.push(line.trim());
        line = w;
      } else line += ' ' + w;
    }
    if (line.trim()) lines.push(line.trim());

    const pad = fs * 0.4;
    const wBox = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
    const hBox = lines.length * (fs + 2) + pad * 2;
    const x = Math.max(wBox / 2 + 4, Math.min(view.width - wBox / 2 - 4, cx));
    const y = above ? cy - r * 1.6 - hBox : cy + r * 1.6;

    ctx.fillStyle = 'rgba(6,10,16,0.85)';
    ctx.fillRect(x - wBox / 2, y, wBox, hBox);
    ctx.strokeStyle = t.kind === 'hostile' ? 'rgba(255,95,69,0.35)' : 'rgba(63,210,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x - wBox / 2, y, wBox, hBox);
    ctx.fillStyle = C.text;
    lines.forEach((l, i) => ctx.fillText(l, x, y + pad + i * (fs + 2)));
  }

  private drawTracers(s: RenderState, basis: ReturnType<typeof basisOf>): void {
    const { ctx, view } = this;
    for (const tr of s.effects.tracers) {
      const age = (s.now - tr.born) / 120;
      const seg = projectSegment(tr.from, tr.to, s.cam, basis, view);
      if (!seg) continue;
      ctx.strokeStyle = `rgba(255,214,140,${(1 - age) * 0.8})`;
      ctx.lineWidth = Math.max(1, view.width / 900) * (1 - age * 0.5);
      ctx.beginPath();
      ctx.moveTo(seg[0].x, seg[0].y);
      ctx.lineTo(seg[1].x, seg[1].y);
      ctx.stroke();
    }
  }

  private drawFloatTexts(s: RenderState, basis: ReturnType<typeof basisOf>): void {
    const { ctx, view } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const t of s.effects.texts) {
      const age = (s.now - t.born) / 900;
      const p = project(t.world, s.cam, basis, view);
      if (!p.visible) continue;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.fillStyle = t.color;
      ctx.font = `700 ${Math.max(12, view.width / 90)}px ui-monospace, monospace`;
      ctx.fillText(t.text, p.x, p.y - age * 40 - 10);
      ctx.globalAlpha = 1;
    }
  }

  private drawWeapon(s: RenderState): void {
    const { ctx, view } = this;
    const cx = view.width / 2;
    const base = view.height;
    const k = view.width / 1000;
    const kick = s.effects.recoil * 26 * k;
    const sway = Math.sin(s.now / 900) * 3 * k;

    ctx.save();
    ctx.translate(cx + sway, base + kick);

    // Barrel + receiver, drawn as a stylised silhouette.
    ctx.fillStyle = '#10161f';
    ctx.strokeStyle = '#2b3b4f';
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.moveTo(-26 * k, 0);
    ctx.lineTo(-18 * k, -150 * k);
    ctx.lineTo(-7 * k, -230 * k);
    ctx.lineTo(7 * k, -230 * k);
    ctx.lineTo(18 * k, -150 * k);
    ctx.lineTo(26 * k, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#18222e';
    ctx.fillRect(-46 * k, -110 * k, 92 * k, 30 * k);
    ctx.strokeRect(-46 * k, -110 * k, 92 * k, 30 * k);

    if (s.effects.muzzle > 0) {
      const a = s.effects.muzzle / 60;
      const g = ctx.createRadialGradient(0, -236 * k, 0, 0, -236 * k, 46 * k);
      g.addColorStop(0, `rgba(255,236,180,${0.9 * a})`);
      g.addColorStop(0.4, `rgba(255,164,60,${0.5 * a})`);
      g.addColorStop(1, 'rgba(255,120,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, -236 * k, 46 * k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCrosshair(s: RenderState): void {
    const { ctx, view } = this;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const k = view.width / 1000;
    const under = s.world.underCrosshair(s.cam);
    const color = under ? (under.kind === 'hostile' ? '#8dff9f' : '#ff7ba0') : 'rgba(210,230,245,0.8)';
    const gap = (7 + s.effects.recoil * 9) * k;
    const len = 9 * k;

    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 1.6 * k);
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as [number, number][]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * gap, cy + dy * gap);
      ctx.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
      ctx.stroke();
    }
    ctx.fillStyle = color;
    ctx.fillRect(cx - 1 * k, cy - 1 * k, 2 * k, 2 * k);

    if (s.pilot === 'jev' && s.lockedId) {
      // Slew line: where the brain is pulling the sight.
      const t = s.world.byId(s.lockedId);
      if (t) {
        const basis = basisOf(s.cam);
        const p = project(t.pos, s.cam, basis, view);
        if (p.visible) {
          ctx.strokeStyle = 'rgba(185,140,255,0.45)';
          ctx.setLineDash([6 * k, 6 * k]);
          ctx.lineWidth = Math.max(1, 1.2 * k);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }

  private drawMarkers(s: RenderState): void {
    const { ctx, view } = this;
    const cx = view.width / 2;
    const cy = view.height / 2;
    const k = view.width / 1000;
    for (const m of s.effects.markers) {
      const age = (s.now - m.born) / 420;
      const spread = (12 + age * 10) * k;
      const len = 8 * k;
      ctx.globalAlpha = Math.max(0, 1 - age);
      ctx.strokeStyle = m.kind === 'foul' ? '#ff5f8a' : m.kind === 'kill' ? '#8dff9f' : '#ffffff';
      ctx.lineWidth = 2.2 * k;
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as [number, number][]) {
        ctx.beginPath();
        ctx.moveTo(cx + dx * spread, cy + dy * spread);
        ctx.lineTo(cx + dx * (spread + len), cy + dy * (spread + len));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawIdleVeil(): void {
    const { ctx, view } = this;
    ctx.fillStyle = 'rgba(4,7,12,0.55)';
    ctx.fillRect(0, 0, view.width, view.height);
  }

  private drawVignette(): void {
    const { ctx, view } = this;
    const g = ctx.createRadialGradient(
      view.width / 2,
      view.height / 2,
      view.height * 0.35,
      view.width / 2,
      view.height / 2,
      view.height * 0.95,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, view.width, view.height);
  }

  /** Muzzle position in world space, for tracers. */
  muzzleWorld(cam: Camera): Vec3 {
    const f = dirFromAngles(cam.yaw, cam.pitch);
    return sub(scale(f, 1.2), vec(0, 0.35, 0));
  }
}

function depth(t: Target, s: RenderState): number {
  const d = sub(t.pos, s.cam.pos);
  return Math.hypot(d.x, d.y, d.z);
}
