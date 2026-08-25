# Running TagCheck on Firebase (free, no server)

This is the setup to pick if you do not want to run or pay for a server. Google
hosts the app and holds the club records; you run nothing. It comes with HTTPS,
which you need anyway because iOS will not give a web page the camera without
it.

**Roughly 15 minutes, once.** You need a Google account and
[Node.js](https://nodejs.org) 22.5 or newer on the machine you deploy from.

> **Will it stay free?** For a club of 10-15 people, comfortably. The free
> Spark plan allows 50,000 document reads and 20,000 writes a day. Tagging a
> bike is one write, and each phone downloads the tag list once and then
> receives only changes, so a heavy drive uses a small fraction of that. No card
> is required, and without one the project cannot spend money.

---

## 1. Make a Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and
   click **Create a project**.
2. Name it (for example `night-owls-mc`). Note the **Project ID** it shows you —
   you will need it in step 6.
3. Turn **Google Analytics off**. You do not need it and it adds prompts.

## 2. Create the database

1. In the left menu open **Build → Firestore Database**, then **Create database**.
2. Choose **Start in production mode**. TagCheck ships its own security rules
   and installs them in step 6; production mode simply means nothing is open in
   the meantime.
3. Pick the region closest to your riders — `asia-south1` (Mumbai) for most of
   India. **This cannot be changed later.**

## 3. Turn on anonymous sign-in

1. **Build → Authentication → Get started**.
2. Open the **Sign-in method** tab, choose **Anonymous**, enable it, save.

This is what gives each phone a stable identity so tags can be credited to a
member, without anyone creating a password.

## 4. Register the app and copy its settings

1. Click the gear icon → **Project settings**.
2. Under **Your apps**, click the web icon (`</>`).
3. Give it a nickname (`TagCheck`), do **not** tick Firebase Hosting, register.
4. Copy the `firebaseConfig` object it shows you.

Paste it into `web/firebase-config.js`, replacing the `null`:

```js
export const firebaseConfig = {
  apiKey: 'AIzaSy...',
  authDomain: 'night-owls-mc.firebaseapp.com',
  projectId: 'night-owls-mc',
  storageBucket: 'night-owls-mc.firebasestorage.app',
  messagingSenderId: '123456789012',
  appId: '1:123456789012:web:abc123def456',
};
```

These values are not secrets — a Firebase web config is public by design. What
protects your records is `firestore.rules`, which you deploy in step 6.

## 5. Add the club settings

In **Firestore Database → Data**, create a collection called `config` with
exactly two documents.

**Document ID `public`** — the club name, readable by anyone:

| Field | Type | Value |
|---|---|---|
| `name` | string | `Night Owls MC` |
| `joinUrl` | string | the link your paper signs point at (or leave empty) |

**Document ID `secrets`** — the codes, readable by nobody:

| Field | Type | Value |
|---|---|---|
| `joinCode` | string | what members type to join, e.g. `RIDE01` |
| `adminCode` | string | your own code, e.g. `BOSS99` |

> The rules deny every client read of `config/secrets`. The rules engine can
> still consult it to check a code, which is how the codes are enforced without
> a server. Do not paste them anywhere else.

Pick codes that are easy to type and read out loud: uppercase letters and
digits, avoiding `O`/`0` and `I`/`1`.

## 6. Deploy

From the project folder:

```bash
npx --yes firebase-tools@15 login
```

Point the CLI at your project (use the Project ID from step 1):

```bash
npx --yes firebase-tools@15 use --add
```

Then deploy the rules and the app together:

```bash
npm run firebase:deploy
```

It prints a **Hosting URL** like `https://night-owls-mc.web.app`. That address
is the app.

## 7. Get your members on it

Send them the Hosting URL and the join code. Each member:

1. Opens the link on their phone.
2. Types their name and the club code.
3. Adds it to their home screen — Safari: **Share → Add to Home Screen**;
   Chrome: **menu → Install app**.

To make yourself an admin, sign in with the **admin** code instead of the join
code. Admins can remove anyone's tag and download the CSV export.

---

## Checking it works

On a real phone, not a laptop:

- Sign in, press **Scan plate**, confirm the camera opens.
- Tag a bike, then check the same plate again — it should come back **Already
  tagged**.
- Have a second person check that plate on their phone. They should see your
  name.
- Turn on flight mode and check a plate. It should still answer, with
  *"Checked against the copy on this phone."*
- Tag a bike in flight mode, then turn the network back on. It should send
  itself.

## Changing the codes later

Edit `config/secrets` in the Firestore console. It takes effect immediately, and
members who already joined stay joined. To remove someone entirely, delete their
document from the `members` collection.

## Keeping a copy of the data

Admins can download everything as CSV from **Totals → Download CSV** in the app.
Do that after a big drive; it is the simplest backup there is.

## If something goes wrong

**"This club is not set up yet: anonymous sign-in is off in Firebase."**
Step 3 was missed or did not save.

**"That club code is not right"** when the code is right.
Check `config/secrets` exists with exactly those field names, all lowercase, and
that the rules deployed — rerun `npm run firebase:rules`.

**The club name shows as "TagCheck".**
`config/public` is missing or misnamed.

**"Missing or insufficient permissions" in the browser console.**
The rules did not deploy. Run `npm run firebase:rules` and watch for errors.

## Testing rule changes before you deploy them

If you edit `firestore.rules`, prove it still holds first. This needs Java:

```bash
npm run test:rules
```

25 checks run against a local emulator, including the one that matters most —
that a second member cannot overwrite an existing tag.

## Going back to the self-hosted version

Set `firebaseConfig` back to `null` in `web/firebase-config.js`. The app returns
to talking to a TagCheck server over HTTP, and the two setups share all the same
code apart from the storage layer.

## What is different from the self-hosted version

Almost nothing that a member would notice, but two things worth knowing:

- **Removing a tag deletes it** rather than marking it removed, so there is no
  history of removed tags. The bike becomes taggable again either way.
- **The member count on Totals counts people who have tagged something**,
  because the rules deliberately stop one member from reading another member's
  record.
