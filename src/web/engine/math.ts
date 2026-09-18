/** Small 3D helpers. Right-handed; the gun sits at the origin looking down -Z. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}
export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}
export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}
export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}
export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}
export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
export function length(a: Vec3): number {
  return Math.sqrt(dot(a, a));
}
export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return scale(a, 1 / l);
}

/** Unit vector for a yaw/pitch pair in radians. yaw 0, pitch 0 looks down -Z. */
export function dirFromAngles(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Inverse of dirFromAngles. */
export function anglesFromDir(v: Vec3): { yaw: number; pitch: number } {
  const n = normalize(v);
  return { yaw: Math.atan2(-n.x, -n.z), pitch: Math.asin(Math.max(-1, Math.min(1, n.y))) };
}

/** Wrap to (-pi, pi]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

export function angleBetween(a: Vec3, b: Vec3): number {
  const c = dot(normalize(a), normalize(b));
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

/** Rodrigues rotation of v around a unit axis. */
export function rotateAround(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = normalize(axis);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kv = cross(k, v);
  const kkv = scale(k, dot(k, v) * (1 - c));
  return add(add(scale(v, c), scale(kv, s)), kkv);
}

export interface Camera {
  pos: Vec3;
  yaw: number;
  pitch: number;
}

export interface Basis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export function basisOf(cam: Camera): Basis {
  const forward = dirFromAngles(cam.yaw, cam.pitch);
  const right = { x: Math.cos(cam.yaw), y: 0, z: -Math.sin(cam.yaw) };
  const up = cross(right, forward);
  return { forward, right, up };
}

export interface Viewport {
  width: number;
  height: number;
  /** Pixels per unit at unit depth. */
  focal: number;
}

export function viewportFor(width: number, height: number, hFovDeg: number): Viewport {
  const focal = width / 2 / Math.tan((hFovDeg * DEG) / 2);
  return { width, height, focal };
}

export interface Projected {
  x: number;
  y: number;
  /** Depth along the view axis, metres. Negative means behind the camera. */
  depth: number;
  visible: boolean;
}

export function project(point: Vec3, cam: Camera, basis: Basis, view: Viewport): Projected {
  const d = sub(point, cam.pos);
  const depth = dot(d, basis.forward);
  if (depth <= 0.05) return { x: 0, y: 0, depth, visible: false };
  const x = dot(d, basis.right);
  const y = dot(d, basis.up);
  return {
    x: view.width / 2 + (view.focal * x) / depth,
    y: view.height / 2 - (view.focal * y) / depth,
    depth,
    visible: true,
  };
}

/** Project a segment, clipping it against the near plane. */
export function projectSegment(
  a: Vec3,
  b: Vec3,
  cam: Camera,
  basis: Basis,
  view: Viewport,
): [Projected, Projected] | null {
  const near = 0.15;
  const da = dot(sub(a, cam.pos), basis.forward);
  const db = dot(sub(b, cam.pos), basis.forward);
  if (da <= near && db <= near) return null;
  let p = a;
  let q = b;
  if (da <= near) {
    const t = (near - da) / (db - da);
    p = add(a, scale(sub(b, a), t));
  } else if (db <= near) {
    const t = (near - db) / (da - db);
    q = add(b, scale(sub(a, b), t));
  }
  const pa = project(p, cam, basis, view);
  const pb = project(q, cam, basis, view);
  if (!pa.visible || !pb.visible) return null;
  return [pa, pb];
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
