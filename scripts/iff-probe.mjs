#!/usr/bin/env node
/**
 * Rubric eval: does the identification rubric actually separate the contact set?
 *
 * Asks one `engage` noul per contact in `contacts.ts` -- all of them in a single
 * System One call -- and scores the answers against the ground truth the
 * scoreboard uses. Run it after touching ENGAGE_CRITERIA in brain.ts; a rubric
 * that reads well and classifies badly is the failure mode this catches.
 *
 *   npm run build
 *   TYPESAFE_API_KEY=... node scripts/iff-probe.mjs
 */

import { CONTACTS } from '../public/js/web/engine/contacts.js';
import { ENGAGE_CRITERIA, ENGAGE_QUESTION, ROLE } from '../public/js/shared/brain.js';
import { DEFAULT_POLICY } from '../public/js/shared/protocol.js';

const key = process.env.TYPESAFE_API_KEY;
if (!key) {
  console.error('TYPESAFE_API_KEY is not set');
  process.exit(2);
}
const model = process.env.TYPESAFE_MODEL ?? 'jev-latest';

const questions = Object.fromEntries(
  CONTACTS.map((c, i) => [
    `c${i}`,
    {
      type: 'noul',
      instructions: {
        role: ROLE,
        question: ENGAGE_QUESTION,
        contact: { seen_through_the_sight: c.desc },
        consequence: 'The gun fires the moment this comes back positive, so answer for this contact only.',
      },
      criteria: ENGAGE_CRITERIA,
    },
  ]),
);

const t0 = Date.now();
const res = await fetch('https://api.typesafe.ai/v1/systemone', {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    state: {
      situation:
        'A fixed defence gun covers a corridor. Contacts appear one at a time, are described by the gunner through the sight, and leave.',
    },
    model,
    questions,
  }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`HTTP ${res.status}:`, JSON.stringify(body).slice(0, 400));
  process.exit(1);
}

const { fireThreshold, holdThreshold } = DEFAULT_POLICY;
const verdict = (p) => (p >= fireThreshold ? 'fire' : p <= holdThreshold ? 'hold' : 'unsure');

let correct = 0;
let wrong = 0;
let unsure = 0;

console.log(`gates: fire >= ${fireThreshold}, hold <= ${holdThreshold}\n`);
for (const [i, c] of CONTACTS.entries()) {
  const p = body.answers[`c${i}`].noul;
  const got = verdict(p);
  const want = c.hostile ? 'fire' : 'hold';
  const mark = got === want ? ' ok ' : got === 'unsure' ? ' ~~ ' : ' XX ';
  if (got === want) correct++;
  else if (got === 'unsure') unsure++;
  else wrong++;
  console.log(`${mark} ${p.toFixed(2)}  ${got.padEnd(6)} want ${want.padEnd(5)} ${c.tricky ? '[tricky] ' : '         '}${c.desc}`);
}

console.log(
  `\n${model}: ${correct}/${CONTACTS.length} decided correctly, ${unsure} held as uncertain, ` +
    `${wrong} wrong. ${Date.now() - t0} ms, ${body.usage.input_tokens} input tokens.`,
);
// Only a flat misclassification fails: "unsure" means the trigger stays shut,
// which is the safe outcome on a contact that genuinely reads both ways.
process.exit(wrong > 0 ? 1 : 0);
