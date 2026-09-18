/** Wiring: canvas, game loop, input, controls, round lifecycle. */

import type { GameMode } from '../shared/protocol.js';
import { Effects, Renderer } from './engine/render.js';
import { DEG, type Camera, clamp, vec } from './engine/math.js';
import { MODES, World, type ShotResult } from './engine/world.js';
import { Hud } from './hud.js';
import { JevLink } from './link.js';
import { JevPilot } from './pilot.js';

const ROUND_MS = 60_000;
const HUMAN_FIRE_MS = 110;
const SENSITIVITY = 0.0023; // radians per pixel of mouse travel

type Pilot = 'jev' | 'human';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const effects = new Effects();
const hud = new Hud();
const link = new JevLink();
const pilot = new JevPilot(link);

let mode: GameMode = 'gridshot';
let who: Pilot = 'jev';
let world = new World(mode, ROUND_MS);
const cam: Camera = { pos: vec(0, 0, 0), yaw: 0, pitch: 0 };
let humanLastShot = 0;
let showOverlay = true;
let lastFrame = performance.now();
let hudAccumulator = 0;

/* ------------------------------ round control ----------------------------- */

function startRound(): void {
  world = new World(mode, ROUND_MS);
  world.reset(mode);
  pilot.reset();
  cam.yaw = 0;
  cam.pitch = 0;
  effects.tracers = [];
  effects.markers = [];
  effects.texts = [];
  hud.hideBanner();
  startButton.textContent = 'END ROUND';
  startButton.classList.add('stop');
  if (who === 'human') requestPointerLock();
}

function endRound(): void {
  world.running = false;
  document.exitPointerLock?.();
  startButton.textContent = 'START ROUND';
  startButton.classList.remove('stop');

  const s = world.stats;
  const rows: [string, string][] = [
    ['points', String(s.points)],
    ['kills', String(s.kills)],
    ['accuracy', `${world.accuracyPct()}%`],
    ['avg time to kill', `${world.avgTtkMs()} ms`],
  ];
  if (MODES[mode].iff) {
    rows.push(['friendly fire', String(s.friendlyFire)]);
    rows.push(['let through correctly', String(s.restraint)]);
  }
  rows.push(['hostiles escaped', String(s.escaped)]);
  if (who === 'jev') {
    rows.push(['System One calls', String(pilot.callsLanded)]);
    rows.push(['latency p50 / p95', `${pilot.latencyPercentile(0.5)} / ${pilot.latencyPercentile(0.95)} ms`]);
    rows.push(['shots withheld', String(pilot.withheld)]);
    rows.push(['input tokens', pilot.inputTokens.toLocaleString()]);
  }
  hud.showBanner(
    'Round over',
    who === 'jev' ? `${link.health.model} on ${MODES[mode].label}` : `human on ${MODES[mode].label}`,
    rows,
  );
}

/* --------------------------------- shots ---------------------------------- */

function handleShot(result: ShotResult, now: number): void {
  const from = renderer.muzzleWorld(cam);
  effects.fire(now, from, result.end);

  if (!result.hit) {
    effects.mark('hit', now);
    return;
  }
  effects.mark(result.friendlyFire ? 'foul' : 'kill', now);
  effects.text(
    result.hit.pos,
    result.points > 0 ? `+${result.points}` : String(result.points),
    result.friendlyFire ? '#ff5f8a' : '#8dff9f',
    now,
  );
}

function humanFire(now: number): void {
  if (!world.running || who !== 'human') return;
  if (now - humanLastShot < HUMAN_FIRE_MS) return;
  humanLastShot = now;
  handleShot(world.shoot(cam, now), now);
  cam.pitch += 0.4 * DEG;
}

/* --------------------------------- loop ----------------------------------- */

function frame(now: number): void {
  const dt = Math.min(64, now - lastFrame);
  lastFrame = now;

  const wasRunning = world.running;
  world.update(now, dt);
  if (world.running && who === 'jev') {
    pilot.update(world, cam, now, dt, (r) => handleShot(r, now));
  }
  effects.update(dt, now);

  renderer.resize();
  renderer.render({
    world,
    cam,
    now,
    effects,
    probabilities: who === 'jev' && pilot.decision ? pilot.decision.probabilities : {},
    lockedId: who === 'jev' ? pilot.lockedId : null,
    cleared: who === 'jev' && pilot.cleared,
    showOverlay: showOverlay && who === 'jev',
    pilot: who,
  });

  hudAccumulator += dt;
  if (hudAccumulator > 80) {
    hudAccumulator = 0;
    hud.updateScore(world);
    hud.updatePanel(pilot);
    hud.drawSpark(pilot);
  }

  if (wasRunning && !world.running) endRound();
  requestAnimationFrame(frame);
}

/* --------------------------------- input ---------------------------------- */

function requestPointerLock(): void {
  void canvas.requestPointerLock?.();
}

canvas.addEventListener('mousedown', (e) => {
  if (who !== 'human') return;
  if (document.pointerLockElement !== canvas) {
    requestPointerLock();
    return;
  }
  if (e.button === 0) humanFire(performance.now());
});

document.addEventListener('mousemove', (e) => {
  if (who !== 'human' || document.pointerLockElement !== canvas) return;
  cam.yaw -= e.movementX * SENSITIVITY;
  cam.pitch = clamp(cam.pitch - e.movementY * SENSITIVITY, -60 * DEG, 60 * DEG);
});

document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    if (world.running) endRound();
    else startRound();
  }
});

/* -------------------------------- controls -------------------------------- */

const startButton = document.getElementById('start') as HTMLButtonElement;
startButton.addEventListener('click', () => (world.running ? endRound() : startRound()));

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-pilot]')) {
  button.addEventListener('click', () => {
    who = button.dataset['pilot'] as Pilot;
    for (const b of document.querySelectorAll('[data-pilot]')) b.classList.toggle('active', b === button);
    if (world.running) endRound();
    hud.showBanner(
      who === 'jev' ? 'Jev has the gun' : 'You have the gun',
      who === 'jev'
        ? 'The model picks targets, clears the trigger and sets the tempo.'
        : 'Click the range to capture the mouse, then shoot. Same scoring.',
    );
  });
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-mode]')) {
  button.addEventListener('click', () => {
    mode = button.dataset['mode'] as GameMode;
    for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('active', b === button);
    hud.setMode(mode);
    if (world.running) endRound();
    world = new World(mode, ROUND_MS);
    hud.showBanner(MODES[mode].label, MODES[mode].blurb);
  });
}

for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tab.addEventListener('click', () => {
    hud.jsonTab = tab.dataset['tab'] as 'request' | 'response';
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
  });
}

function bindSlider(id: string, label: string, apply: (value: number) => void, format: (v: number) => string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  const out = document.getElementById(label) as HTMLElement;
  const sync = (): void => {
    const value = Number(input.value);
    apply(value);
    out.textContent = format(value);
  };
  input.addEventListener('input', sync);
  sync();
}

bindSlider('i-fire', 'v-fire', (v) => (pilot.config.policy.fireThreshold = v), (v) => v.toFixed(2));
bindSlider('i-hold', 'v-hold', (v) => (pilot.config.policy.holdThreshold = v), (v) => v.toFixed(2));
bindSlider('i-conf', 'v-conf', (v) => (pilot.config.policy.minConfidence = v), (v) => v.toFixed(2));
bindSlider('i-gap', 'v-gap', (v) => (pilot.config.decisionIntervalMs = v), (v) => `${v} ms`);

const overlayToggle = document.getElementById('i-overlay') as HTMLInputElement;
overlayToggle.addEventListener('change', () => (showOverlay = overlayToggle.checked));

window.addEventListener('resize', () => renderer.resize());

/* --------------------------------- boot ----------------------------------- */

async function boot(): Promise<void> {
  hud.setMode(mode);
  hud.setLink(link.health, link.mode);
  hud.showBanner('Stand by', 'Pick a pilot and a drill, then start the round. (space also starts)');
  renderer.resize();
  requestAnimationFrame(frame);

  const info = await link.probe();
  hud.setLink(info, link.mode);
  if (info.source === 'simulator') {
    hud.showBanner(
      'Stand by',
      link.mode === 'server'
        ? 'No TYPESAFE_API_KEY on the server: the built-in simulator is standing in for Jev.'
        : 'Served as static files: the built-in simulator is standing in for Jev.',
    );
  }
}

void boot();
