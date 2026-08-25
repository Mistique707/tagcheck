/**
 * Fill a database with sample tags so a new deployment can be tried out before
 * a drive. Safe to run repeatedly; it never touches plates that already exist.
 *
 *   npm run seed
 */

import { insertTag, findActiveTag, upsertMember } from '../server/src/db.js';
import { fuzzyKey, normalizePlate } from '../shared/plate.js';

const MEMBERS = [
  { name: 'Asha', deviceId: 'seed-device-asha' },
  { name: 'Bala', deviceId: 'seed-device-bala' },
  { name: 'Ravi', deviceId: 'seed-device-ravi' },
];

const SAMPLES = [
  ['MH12AB1234', 'Black Classic 350, outside the cafe'],
  ['MH14DE5678', 'Blue Duke by the ATM'],
  ['KA01HA9999', 'Red Interceptor, second row'],
  ['TN09BC4455', ''],
  ['DL8CAF1234', 'Silver Himalayan near the gate'],
  ['23BH1234AB', 'New plate series, white Meteor'],
];

const members = MEMBERS.map((member) => upsertMember(member));

let added = 0;
for (const [index, [plate, note]] of SAMPLES.entries()) {
  const reading = normalizePlate(plate);
  if (!reading.ok) {
    console.warn(`skipping unreadable sample: ${plate}`);
    continue;
  }
  if (findActiveTag(reading.plate)) continue;

  insertTag({
    plate: reading.plate,
    fuzzy: fuzzyKey(reading.plate),
    format: reading.format,
    memberId: members[index % members.length].id,
    note: note || null,
    clientTagId: `seed-${reading.plate}`,
  });
  added += 1;
}

console.log(`Seeded ${added} tag(s) across ${members.length} members.`);
