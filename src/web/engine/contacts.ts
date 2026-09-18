/**
 * Contact descriptions for the IFF mode.
 *
 * Each entry carries the ground truth the scoreboard uses. The "tricky" ones
 * are compound: a keyword reader gets them wrong, a model that actually reads
 * the sentence should not. That gap is the point of the mode.
 */

export interface ContactType {
  desc: string;
  hostile: boolean;
  tricky?: boolean;
}

export const CONTACTS: ContactType[] = [
  // Plainly hostile
  { desc: 'a stub-winged drone with an autocannon slung under the nose', hostile: true },
  { desc: 'a matte quadcopter, missile rails loaded', hostile: true },
  { desc: 'an interceptor painting us with a targeting laser', hostile: true },
  { desc: 'a scarred attack rotor, diving toward the emplacement', hostile: true },
  { desc: 'a hunter drone with no markings, weapon hardpoints full', hostile: true },
  { desc: 'a raider skiff, gun pod tracking left and right', hostile: true },

  // Plainly protected
  { desc: 'a medevac quadcopter, red cross on the nose', hostile: false },
  { desc: 'a civilian survey drone carrying a camera pod and nothing else', hostile: false },
  { desc: 'a relief lifter hauling water cans in a sling', hostile: false },
  { desc: 'an unarmed press drone, empty rails, blue livery', hostile: false },
  { desc: 'a friendly scout squawking our own beacon', hostile: false },
  { desc: 'a census drone from the survey office, stripped of weapons', hostile: false },

  // Compound: the words point one way, the sentence points the other
  { desc: 'a medevac hull with a turret bolted into the side door', hostile: true, tricky: true },
  { desc: 'a supply lifter whose cargo crate has opened into a missile pod', hostile: true, tricky: true },
  { desc: 'a white drone squawking a friendly beacon stolen off a squadron we buried last week', hostile: true, tricky: true },
  { desc: 'an armoured ambulance rotor, scarred and burnt but carrying no weapons at all', hostile: false, tricky: true },
  { desc: 'a decommissioned gunship flying casualties out, its hardpoints cut away', hostile: false, tricky: true },
  { desc: 'an aid drone that looks aggressive only because it is running from the smoke', hostile: false, tricky: true },
];

export function pickContact(rand: () => number): ContactType {
  const wantHostile = rand() < 0.5;
  const wantTricky = rand() < 0.3;
  const pool = CONTACTS.filter((c) => c.hostile === wantHostile && !!c.tricky === wantTricky);
  const fallback = CONTACTS.filter((c) => c.hostile === wantHostile);
  const list = pool.length ? pool : fallback;
  return list[Math.floor(rand() * list.length)] ?? CONTACTS[0]!;
}
