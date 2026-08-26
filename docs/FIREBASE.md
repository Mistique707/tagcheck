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

Save it as `firebase.config.json` in the project root, as plain JSON:

```json
{
  "apiKey": "AIzaSy...",
  "authDomain": "night-owls-mc.firebaseapp.com",
  "projectId": "night-owls-mc",
  "storageBucket": "night-owls-mc.firebasestorage.app",
  "messagingSenderId": "123456789012",
  "appId": "1:123456789012:web:abc123def456"
}
```

`npm run build:web` injects it into the deployed app. The file is git-ignored,
so it never reaches your repository.

**These values are not secrets.** A Firebase web config ships inside every page
your app serves — it has to, for the app to work at all — and Google documents
it as public. It is kept out of the repository only because GitHub secret
scanning flags the `AIza…` pattern (the same shape is used for billable Google
APIs where a key *does* matter), and an alert people learn to ignore is worse
than no alert.

What actually protects your records is `firestore.rules`, deployed in step 6,
plus restricting the key to your own domains — see below.

### Restrict the key to your own site

This is the one genuinely useful security step, and it takes two minutes.

1. Open [Google Cloud → Credentials](https://console.cloud.google.com/apis/credentials)
   and pick your project.
2. Under **API keys**, click the one Firebase created (usually *Browser key
   (auto created by Firebase)*).
3. Under **Application restrictions**, choose **Websites**, and add:
   - `tagcheck-adc9c.web.app/*` (your Hosting URL)
   - `tagcheck-adc9c.firebaseapp.com/*`
   - `localhost/*` if you want to keep testing locally
4. Save. It can take a few minutes to take effect.

Without this the key is unrestricted, so anyone could use it to create
anonymous accounts against your project. They still could not read or write a
single tag — the rules stop that — but they could burn quota, and if you ever
enable a billable Google API on the project, an unrestricted key is a real
liability.

## 5. Add the club settings

In **Firestore Database → Data**, create a collection called `config` with
exactly two documents.

**Document ID `public`** — the club name, readable by anyone:

| Field | Type | Value |
|---|---|---|
| `name` | string | `Night Owls MC` |
| `joinUrl` | string | the link your paper signs point at (or leave empty) |

**Document ID `secrets`** — the club code, readable by nobody:

| Field | Type | Value |
|---|---|---|
| `joinCode` | string | anything you like, e.g. `RIDE01` |

> The rules deny every client read of `config/secrets`. The rules engine can
> still consult it to check a code, which is how joining is controlled without
> a server.

**Nobody ever types this code.** It goes in the invite link you send out
(step 7), so your friends only type their name. It exists so that a stranger
who lands on the bare address cannot add junk to your list — and a junk tag is
worse than it sounds, because it makes a real bike look already tagged and
nobody hangs a card on it.

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

## 7. Send out the invite link

Take the Hosting URL and add your club code to the end of it, after `#join=`:

```
https://night-owls-mc.web.app/#join=RIDE01
```

**That link is the whole onboarding.** Send it to the group chat. Each friend:

1. Taps the link on their phone.
2. Types their name. That is the only thing they ever type.
3. Adds it to their home screen — Safari: **Share → Add to Home Screen**;
   Chrome: **menu → Install app**.

The app takes the code out of the link, remembers it, and wipes it from the
address bar so it is not sitting in a screenshot. From then on the phone opens
straight into the scanner.

Everyone who joins is equal: there are no admins. Any member can remove any
tag — the usual reason is fixing someone else's mistake while they are not
around — and anyone can download the CSV.

> Keep the plain address (without `#join=...`) to yourself. Someone who opens
> it cannot join, which is exactly the point.

---

## Checking it works

On a real phone, not a laptop:

- Open the invite link, type a name, press **Scan plate**, confirm the camera
  opens.
- Tag a bike, then check the same plate again — it should come back **Already
  tagged**.
- Have a second person check that plate on their phone. They should see your
  name.
- Turn on flight mode and check a plate. It should still answer, with
  *"Checked against the copy on this phone."*
- Tag a bike in flight mode, then turn the network back on. It should send
  itself.

## Better plate reading with Cloud Vision (optional)

On-device recognition is a document scanner being asked to read a dirty metal
plate at an angle. Measured with `tools/ocr-bench.js`, it gets **83%** on a
perfectly framed plate and **30-45%** on a realistic one. Cloud Vision is
trained on photographs of the world, which is the actual problem here.

This is optional. Without it nothing changes, and no image ever leaves a phone.

### What it costs, and what it changes

Vision is free for the first **1,000 images a month**, then roughly **$1.50 per
1,000**. Fifteen people would have to scan very hard to leave the free tier —
but it does require **billing enabled**, which means a card on file.

It also means the cropped guide box — not the whole camera frame — is sent to
Google whenever the phone has signal. Nothing is sent offline, and typing a
plate never sends anything. If that trade is wrong for your club, skip this.

### 1. Enable billing and the API

1. [Enable billing](https://console.cloud.google.com/billing) on the project.
2. Enable the [Cloud Vision API](https://console.cloud.google.com/apis/library/vision.googleapis.com).

### 2. Cap the quota. Do not skip this

A key that can spend money is sitting in a public web page. Domain restriction
helps but is not airtight, so put a hard ceiling underneath it:

1. Open [Vision API → Quotas](https://console.cloud.google.com/apis/api/vision.googleapis.com/quotas).
2. Set the per-day request quota to something your club cannot reach but an
   abuser would hit at once — **500 a day** is generous for fifteen people.
3. Add a [budget alert](https://console.cloud.google.com/billing/budgets) at a
   small figure, say $5, so you hear about it either way.

With that ceiling the worst case is around $20 in a month. **Without it there is
no upper limit at all.**

### 3. Make a separate, restricted key

Do not reuse the Firebase key. In
[Credentials](https://console.cloud.google.com/apis/credentials):

1. **Create credentials → API key**, named something like `TagCheck Vision`.
2. **Application restrictions → Websites**: `tagcheck-adc9c.web.app/*` and
   `tagcheck-adc9c.firebaseapp.com/*`.
3. **API restrictions → Restrict key →** Cloud Vision API, and nothing else.

### 4. Add it and deploy

One extra field in `firebase.config.json`:

```json
{
  "apiKey": "AIza...",
  "projectId": "your-project",
  "visionApiKey": "AIza...the-vision-key..."
}
```

```bash
npm run firebase:deploy
```

The build prints which reader is active. Vision is tried first when there is
signal; on-device recognition takes over if it fails, runs out of quota, or the
phone is offline. Typing always works.

### 5. Check that it actually helped

Open the app, paste `tools/ocr-bench.js` into the browser console, then:

```
await ocrBench({ levels: [0.3, 0.6] })
```

Compare against the on-device figures above. If it has not clearly improved,
take the key back out — there is no sense paying for something that is not
better.

## Changing the code later

Edit `joinCode` in `config/secrets` in the Firestore console, then send out a
fresh invite link with the new code. It takes effect immediately, and members
who already joined stay joined. To remove someone entirely, delete their
document from the `members` collection.

## Keeping a copy of the data

Any member can download everything as CSV from **Totals → Download the list as
CSV**. Do that after a big drive; it is the simplest backup there is.

## If something goes wrong

**"This club is not set up yet: anonymous sign-in is off in Firebase."**
Step 3 was missed or did not save.

**"This link is missing its club code."**
The `#join=...` part was stripped — some chat apps do this. The member can open
**I was given a code** on the sign-in screen and type it once instead.

**"This invite link is not valid for this club."**
The code in the link does not match `joinCode` in `config/secrets`. Check for a
typo, and that the rules deployed — rerun `npm run firebase:rules`.

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
- **Signing out gives that phone a new identity.** Past tags stay credited to
  the old name. There is normally no reason to sign out at all.
