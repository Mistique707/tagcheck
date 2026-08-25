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
const ADMIN_CODE = 'BOSS99';

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
    await setDoc(doc(db, 'config', 'secrets'), { joinCode: JOIN_CODE, adminCode: ADMIN_CODE });
    await setDoc(doc(db, 'members', 'asha'), {
      name: 'Asha', code: JOIN_CODE, admin: false, createdAt: new Date(),
    });
    await setDoc(doc(db, 'members', 'ravi'), {
      name: 'Ravi', code: ADMIN_CODE, admin: true, createdAt: new Date(),
    });
  });
}

const asAsha = () => testEnv.authenticatedContext('asha').firestore();
const asBala = () => testEnv.authenticatedContext('bala').firestore();
const asRavi = () => testEnv.authenticatedContext('ravi').firestore();
const asStranger = () => testEnv.unauthenticatedContext().firestore();

/**
 * A valid tag payload. The rules require createdAt to be the server's own
 * clock, so a real client must use serverTimestamp() -- a date chosen by the
 * phone is refused, which is what stops a backdated tag.
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

/* Config ------------------------------------------------------------------ */

test('anyone may read the club name', async () => {
  await reset();
  await assertSucceeds(getDoc(doc(asStranger(), 'config', 'public')));
});

test('nobody may read the join and admin codes', async () => {
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

test('the join code lets a new phone become a member', async () => {
  await reset();
  await assertSucceeds(setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: JOIN_CODE, admin: false, createdAt: new Date(),
  }));
});

test('a wrong code cannot become a member', async () => {
  await reset();
  await assertFails(setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: 'GUESS', admin: false, createdAt: new Date(),
  }));
});

test('the join code cannot grant admin', async () => {
  await reset();
  await assertFails(setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: JOIN_CODE, admin: true, createdAt: new Date(),
  }));
});

test('the admin code does grant admin', async () => {
  await reset();
  await assertSucceeds(setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: ADMIN_CODE, admin: true, createdAt: new Date(),
  }));
});

test('a member cannot create a record for someone else', async () => {
  await reset();
  await assertFails(setDoc(doc(asBala(), 'members', 'asha'), {
    name: 'Not Asha', code: JOIN_CODE, admin: false, createdAt: new Date(),
  }));
});

test('a member may fix their own name but not promote themselves', async () => {
  await reset();
  await assertSucceeds(updateDoc(doc(asAsha(), 'members', 'asha'), { name: 'Asha K' }));
  await assertFails(updateDoc(doc(asAsha(), 'members', 'asha'), { admin: true }));
});

test('members cannot read each other, but admins can', async () => {
  await reset();
  await assertFails(getDoc(doc(asAsha(), 'members', 'ravi')));
  await assertSucceeds(getDoc(doc(asAsha(), 'members', 'asha')));
  await assertSucceeds(getDoc(doc(asRavi(), 'members', 'asha')));
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
  await setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: JOIN_CODE, admin: false, createdAt: new Date(),
  });
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

test('a tag cannot be filed under someone elses name', async () => {
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

test('a member may remove their own recent tag', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  await assertSucceeds(deleteDoc(doc(asAsha(), 'tags', 'MH12AB1234')));
});

test('a member may not remove someone elses tag', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  await setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: JOIN_CODE, admin: false, createdAt: new Date(),
  });
  await assertFails(deleteDoc(doc(asBala(), 'tags', 'MH12AB1234')));
});

test('a member may not remove their own tag after the undo window', async () => {
  await reset();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await setDoc(doc(context.firestore(), 'tags', 'MH12AB1234'),
      tagPayload('asha', 'Asha', 'MH12AB1234', { createdAt: old }));
  });
  await assertFails(deleteDoc(doc(asAsha(), 'tags', 'MH12AB1234')));
});

test('an admin may remove any tag, however old', async () => {
  await reset();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await setDoc(doc(context.firestore(), 'tags', 'MH12AB1234'),
      tagPayload('asha', 'Asha', 'MH12AB1234', { createdAt: old }));
  });
  await assertSucceeds(deleteDoc(doc(asRavi(), 'tags', 'MH12AB1234')));
});

test('a removed tag frees the bike to be tagged again', async () => {
  await reset();
  await setDoc(doc(asAsha(), 'tags', 'MH12AB1234'), tagPayload('asha', 'Asha', 'MH12AB1234'));
  await deleteDoc(doc(asAsha(), 'tags', 'MH12AB1234'));
  await setDoc(doc(asBala(), 'members', 'bala'), {
    name: 'Bala', code: JOIN_CODE, admin: false, createdAt: new Date(),
  });
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
