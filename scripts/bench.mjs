#!/usr/bin/env node
/**
 * Headless range: runs the same World and JevPilot the browser runs, with no
 * browser. Useful for measuring the real model against the simulator, or one
 * policy against another, without watching 60 seconds of gunfire.
 *
 *   npm run build
 *   node scripts/bench.mjs --mode triage --seconds 30
 *   node scripts/bench.mjs --mode triage --server http://127.0.0.1:8787   # uses the server's brain
 *
 * Add --trace to print what the pilot is doing every second.
 */

import { World, MODES } from '../public/js/web/engine/world.js';
import { JevPilot } from '../public/js/web/pilot.js';
import { JevLink } from '../public/js/web/link.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);

const mode = arg('mode', 'gridshot');
const seconds = Number(arg('seconds', 30));
const server = arg('server', null);
const trace = flag('trace');

if (!MODES[mode]) {
  console.error(`unknown mode "${mode}" (expected: ${Object.keys(MODES).join(', ')})`);
  process.exit(2);
}

const link = new JevLink(server ?? '');
if (server) await link.probe();
const pilot = new JevPilot(link);
const world = new World(mode, seconds * 1000);
const cam = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 };

world.reset(mode);
pilot.reset();

const STEP = 16;
let now = performance.now();
let nextTrace = now + 1000;

while (world.running) {
  world.update(now, STEP);
  pilot.update(world, cam, now, STEP, () => {});
  if (trace && now >= nextTrace) {
    nextTrace = now + 1000;
    const d = pilot.decision;
    console.log(
      `t=${(world.roundMs - world.timeLeftMs) / 1000}s lock=${pilot.lockedId} live=${world.live().length} ` +
        `shots=${world.stats.shots} kills=${world.stats.kills} ff=${world.stats.friendlyFire} ` +
        `calls=${pilot.callsLanded} withheld=${pilot.withheld} ` +
        `last=${d ? `${d.targetId}/${d.fire}/${d.engage.toFixed(2)}@${d.engageTargetId}` : '-'}`,
    );
  }
  now += STEP;
  // Let pending System One calls resolve; the loop runs in real time.
  await new Promise((r) => setTimeout(r, STEP));
}

const s = world.stats;
console.log(
  JSON.stringify(
    {
      mode,
      brain: link.health.model,
      source: link.health.source,
      seconds,
      points: s.points,
      shots: s.shots,
      kills: s.kills,
      accuracy_pct: world.accuracyPct(),
      avg_ttk_ms: world.avgTtkMs(),
      friendly_fire: s.friendlyFire,
      let_through: s.restraint,
      escaped: s.escaped,
      decisions: pilot.callsLanded,
      stale_decisions: pilot.staleCalls,
      withheld: pilot.withheld,
      fallbacks: pilot.fallbacks,
      latency_p50_ms: pilot.latencyPercentile(0.5),
      latency_p95_ms: pilot.latencyPercentile(0.95),
      input_tokens: pilot.inputTokens,
    },
    null,
    2,
  ),
);
