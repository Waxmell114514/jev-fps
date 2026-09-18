#!/usr/bin/env node
/**
 * Headless smoke test: boots a browser, plays a round, and checks that the
 * game rendered, that decisions actually came back, and that the gun shot
 * something. Requires Playwright (`npm i -g playwright` or a local install).
 *
 *   node scripts/smoke.mjs --url http://127.0.0.1:8787 --mode triage --seconds 20
 */

import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('playwright is not installed; skipping smoke test');
  process.exit(0);
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith('--')) acc.push([arg.slice(2), all[i + 1]?.startsWith('--') ? 'true' : all[i + 1]]);
    return acc;
  }, []),
);

const url = args.url ?? 'http://127.0.0.1:8787';
const mode = args.mode ?? 'gridshot';
const seconds = Number(args.seconds ?? 20);
const shot = args.shot ?? null;

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(url, { waitUntil: 'networkidle' });
await page.click(`[data-mode="${mode}"]`);
await page.click('#start');
await page.waitForTimeout(seconds * 1000);

const read = async (id) => (await page.textContent(`#${id}`))?.trim();
const result = {
  mode,
  points: await read('s-points'),
  kills: await read('s-kills'),
  accuracy: await read('s-acc'),
  ttk: await read('s-ttk'),
  friendlyFire: await read('s-ff'),
  clock: await read('s-clock'),
  decisions: await read('p-calls'),
  latency: await read('p-latency'),
  percentiles: await read('p-latency-p'),
  tokens: await read('p-tokens'),
  cost: await read('p-cost'),
  withheld: await read('p-withheld'),
  verdict: await read('p-verdict'),
  brain: await read('brain-badge'),
};

if (shot) {
  writeFileSync(shot, await page.screenshot());
  result.screenshot = shot;
}

await browser.close();

console.log(JSON.stringify(result, null, 2));

const kills = Number(result.kills);
const decisions = Number(String(result.decisions).split(' ')[0]);
if (problems.length) {
  console.error('\nbrowser problems:\n  ' + problems.join('\n  '));
  process.exit(1);
}
if (!Number.isFinite(kills) || kills <= 0) {
  console.error(`\nFAIL: the gun killed nothing in ${seconds}s`);
  process.exit(1);
}
if (!Number.isFinite(decisions) || decisions <= 0) {
  console.error('\nFAIL: no System One decisions landed');
  process.exit(1);
}
console.log(`\nOK: ${kills} kills from ${decisions} decisions in ${seconds}s`);
