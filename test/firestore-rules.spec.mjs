/**
 * Security rule tests, run against the Firestore emulator.
 *
 * In the serverless setup these rules ARE the server: nothing else stands
 * between a phone and the club records. The duplicate guarantee in particular
 * is a rule ("create yes, update never" on a document keyed by the plate), so
 * it deserves to be proven rather than assumed.
 *
 *   npm run test:rules
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  assertFails, assertSucceeds, initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc,
} from 'firebase/firestore';

const JOIN_CODE = 'RIDE01';

const testEnv = await initializeTestEnvironment({
  projectId: 'tagcheck-rules-test',
  firestore: {
    rules: readFileSync('firestore.rules', 'utf8'),
    host: '127.0.0.1',
    port: 8080,
  },
});

test.after(() => testEnv.cleanup());

/** Seed the club config and a couple of members, bypassing the rules. */
async function reset() {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'config', 'public'), { name: 'Night Owls MC', joinUrl: '' });
    await setDoc(doc(db, 'config', 'secrets'), { joinCode: JOIN_CODE });
    await setDoc(doc(db, 'members', 'asha'), {
      name: 'Asha', code: JOIN_CODE, createdAt: new Date(),
    });
    await setDoc(doc(db, 'members', 'ravi'), {
      name: 'Ravi', code: JOIN_CODE, createdAt: new Date(),
    });
  });
}

const asAsha = () => testEnv.authenticatedContext('asha').firestore();
const asBala = () => testEnv.authenticatedContext('bala').firestore();
const asRavi = () => testEnv.authenticatedContext('ravi').firestore();
const asStranger = () => testEnv.unauthenticatedContext().firestore();

/**
 * A valid tag payload. The rules require createdAt to be the server clock, so a
 * real client must use serverTimestamp() -- a date chosen by the phone is
 * refused, which is what stops a backdated tag.
 */
function tagPayload(uid, name, plate, extra = {}) {
  return {
    plate,
    fuzzy: plate,
    format: 'standard',
    memberUid: uid,
    memberName: name,
    note: '',
    createdAt: serverTimestamp(),
    ...extra,
  };
}

const joinPayload = (name) => ({ name, code: JOIN_CODE, createdAt: new Date() });

/* Config ------------------------------------------------------------------ */

test('anyone may read the club name', async () => {
  await reset();
  await assertSucceeds(getDoc(doc(asStranger(), 'config', 'public')));
});

test('nobody may read the join code', async () => {
  await reset();
  await assertFails(getDoc(doc(asStranger(), 'config', 'secrets')));
  await assertFails(getDoc(doc(asAsha(), 'config', 'secrets')));
  await assertFails(getDoc(doc(asRavi(), 'config', 'secrets')));
});

test('nobody may rewrite the club config', async () => {
  await reset();
  await assertFails(setDoc(doc(asRavi(), 'config', 'public'), { name: 'Hijacked' }));
  await assertFails(setDoc(doc(asRavi(), 'config', 'secrets'), { joinCode: 'OPEN' }));
});

/* Joining ----------------------------------------------------------------- */

test('the code from the invite link lets a new phone become a member', async () => {
  await reset();
  await assertSucceeds(setDoc(doc(asBala(), 'members', 'bala'), joinPayload('Bala')));
});

test('a wrong code cannot become a member', async () => {
  await reset();
  await assertFails(setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: 'GUESS', createdAt: new Date(),
  }));
});

test('a missing code cannot become a member', async () => {
  await reset();
  await assertFails(setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', createdAt: new Date(),
  }));
});

test('a nameless or absurdly long name is refused', async () => {
  await reset();
  for (const name of ['A', 'x'.repeat(41)]) {
    await assertFails(setDoc(doc(asBala(), 'members', 'bala'), {
      name, code: JOIN_CODE, createdAt: new Date(),
    }));
  }
});

test('a member cannot create a record for someone else', async () => {
  await reset();
  await assertFails(setDoc(doc(asBala(), 'members', 'asha'), joinPayload('Not Asha')));
});

test('a member may fix their own name', async () => {
  await reset();
  await assertSucceeds(updateDoc(doc(asAsha(), 'members', 'asha'), { name: 'Asha K' }));
});

test('a member cannot swap the code stored on their own record', async () => {
  await reset();
  await assertFails(updateDoc(doc(asAsha(), 'members', 'asha'), { code: 'GUESS' }));
});

test('members cannot read each other', async () => {
  await reset();
  await assertSucceeds(getDoc(doc(asAsha(), 'members', 'asha')));
  await assertFails(getDoc(doc(asAsha(), 'members', 'ravi')));
});

/* Tagging ----------------------------------------------------------------- */

test('a member may tag a free bike', async () => {
  await reset();
  await assertSucceeds(setDoc(
    doc(asAsha(), 'tags', 'MH12AB1234'),
    tagPayload('asha', 'Asha', 'MH12AB1234'),
  ));
});

test('someone who has not joined cannot tag or read anything', async () => {
  await reset();
  await assertFails(setDoc(
    doc(asStranger(), 'tags', 'MH12AB1234'),
    tagPayload('nobody', 'Nobody', 'MH12AB1234'),
  ));
  await assertFails(getDoc(doc(asStranger(), 'tags', 'MH12AB1234')));
});

test('signing in anonymously is not enough without joining the club', async () => {
  await reset();
  // Bala is authenticated but has no member record yet.
  await assertFails(setDoc(
    doc(asBala(), 'tags', 'MH12AB1234'),
    tagPayload('bala', 'Bala', 'MH12AB1234'),
  ));
});

test('THE GUARANTEE: a second member cannot overwrite an existing tag', async () => {
  await reset();
  await assertSucceeds(setDoc(
    doc(asAsha(), 'tags', 'MH12AB1234'),
    tagPayload('asha', 'Asha', 'MH12AB1234'),
  ));
  // Bala joins properly, then tries to take the same bike.
  await setDoc(doc(asBala(), 'members', 'bala'), joinPayload('Bala'));
  await assertFails(setDoc(
    doc(asBala(), 'tags', 'MH12AB1234'),
    tagPayload('bala', 'Bala', 'MH12AB1234'),
  ));
});

test('a tag can never be edited, not even by the member who made it', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  await assertFails(updateDoc(doc(asAsha(), 'tags', 'MH12AB1234'), { note: 'changed' }));
});

test('a tag cannot be filed under another members name', async () => {
  await reset();
  await assertFails(setDoc(
    doc(asAsha(), 'tags', 'KA01HA9999'),
    tagPayload('ravi', 'Ravi', 'KA01HA9999'),
  ));
});

test('the document id must match the plate inside it', async () => {
  await reset();
  await assertFails(setDoc(
    doc(asAsha(), 'tags', 'KA01HA9999'),
    tagPayload('asha', 'Asha', 'MH12AB1234'),
  ));
});

test('an oversized note is refused', async () => {
  await reset();
  await assertFails(setDoc(
    doc(asAsha(), 'tags', 'KA01HA9999'),
    tagPayload('asha', 'Asha', 'KA01HA9999', { note: 'x'.repeat(281) }),
  ));
});

test('a backdated tag is refused', async () => {
  await reset();
  await assertFails(setDoc(
    doc(asAsha(), 'tags', 'KA01HA9999'),
    tagPayload('asha', 'Asha', 'KA01HA9999', { createdAt: new Date('2020-01-01') }),
  ));
});

/* Removing ---------------------------------------------------------------- */

test('a member may remove their own tag', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  await assertSucceeds(deleteDoc(doc(asAsha(), 'tags', 'MH12AB1234')));
});

test('any member may remove another members tag, however old', async () => {
  // Friends fixing a mistake for each other is the common case, not an attack.
  await reset();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await setDoc(doc(context.firestore(), 'tags', 'MH12AB1234'),
      tagPayload('asha', 'Asha', 'MH12AB1234', { createdAt: old }));
  });
  await assertSucceeds(deleteDoc(doc(asRavi(), 'tags', 'MH12AB1234')));
});

test('someone outside the club still may not remove a tag', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  // Bala is signed in anonymously but has never joined.
  await assertFails(deleteDoc(doc(asBala(), 'tags', 'MH12AB1234')));
  await assertFails(deleteDoc(doc(asStranger(), 'tags', 'MH12AB1234')));
});

test('a removed tag frees the bike to be tagged again', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  await deleteDoc(doc(asAsha(), 'tags', 'MH12AB1234'));
  await setDoc(doc(asBala(), 'members', 'bala'), joinPayload('Bala'));
  await assertSucceeds(setDoc(
    doc(asBala(), 'tags', 'MH12AB1234'),
    tagPayload('bala', 'Bala', 'MH12AB1234'),
  ));
});

/* Everything else --------------------------------------------------------- */

test('collections that do not exist in the design are closed', async () => {
  await reset();
  await assertFails(setDoc(doc(asRavi(), 'whatever', 'x'), { a: 1 }));
  await assertFails(getDoc(doc(asRavi(), 'whatever', 'x')));
});
