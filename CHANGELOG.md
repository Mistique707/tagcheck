# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-08-25

Plate reading was not good enough for a real car park. This measures the gap and
offers a way to close it.

### Added

- **A realistic benchmark** (`tools/ocr-bench.js`). It renders plates with dust,
  shadow, glare, blur, sensor noise and 3D tilt, sitting small inside a
  cluttered frame, and reports exact-match accuracy. Every accuracy claim in
  this project now comes from it. On-device recognition measures **83%** on a
  perfectly framed plate but **30-45%** on a realistic one, which is the gap
  between the earlier tests and how it behaved in the field.
- **Optional Google Cloud Vision** as the primary reader, with on-device
  recognition as the fallback and typing always available. Off unless a
  `visionApiKey` is configured, so nothing changes for anyone who does not want
  it. Only the cropped guide box is sent, only when online.
- Setup instructions that treat a **daily quota cap as required**, not advisory:
  a billable key in a public web page needs a hard ceiling under it, or the
  worst case has no upper bound.

### Notes

Plate localisation, Sauvola adaptive thresholding and confidence-weighted voting
across preprocessing variants were built and measured, and are **not** in this
release: 8/20 with them, 8/20 without, against a 9/20 baseline — identical
misses on the harder set. The bottleneck is the recognition engine, not the
pixels fed to it. The work is kept on the `ocr-classical-cv-experiment` branch
rather than shipped, since it would have made every scan slower for no gain.

## [2.0.2] - 2026-08-25

### Fixed

- **Deploys did not reach phones that already had the app.** `firebase.json`
  listed a `no-cache` rule for `/sw.js` before a broad `**/*.@(js|css)` rule
  that set an hour of caching, and later rules win — so the service worker
  itself was cached. A stale worker then kept serving stale CSS and JavaScript
  out of its own cache, which is why the 2.0.1 menu fix was live on the server
  and still invisible on a phone. The fresh-content rules now come last.
- The service worker filled its cache through the browser HTTP cache, so a
  newly installed worker could copy an already-stale file and then serve that
  copy for its whole life. It now fetches shell files with `cache: 'reload'`.

### Added

- The app checks for a new service worker on every launch and reloads once when
  one takes over, so a fix reaches members without anyone clearing anything.

## [2.0.1] - 2026-08-25

Two bugs found in real use, both worse than they looked.

### Fixed

- **The menu would not close.** Hiding an element sets the `hidden` attribute,
  which the browser honours through a user-agent rule — and author CSS beats the
  user agent regardless of specificity. `.menu { display: grid }` therefore kept
  the menu on screen forever, and the same applied to every `.btn` the app tries
  to hide, including **Remove this tag**. One `[hidden] { display: none }` rule
  fixes the lot.
- **Plate scanning never worked at all.** Three separate causes, found in this
  order:
  1. The check for a self-hosted OCR engine treated any `200` as success. Both
     the Node server and Firebase Hosting rewrite unknown paths to `index.html`
     for the single-page app, so the probe always "found" an engine and the
     browser then refused to run an HTML page as JavaScript. The check now
     requires a JavaScript content type.
  2. The scanner was built for car plates: a wide 4:1.4 guide box and a
     single-line page-segmentation mode. Indian motorcycle plates are usually
     **two rows**, which cannot be read that way. The guide is now 2:1 and the
     engine reads a block, falling back through other modes.
  3. A two-row plate arrives as one block with a newline in it. `bestReading`
     split on that newline and scored the halves, and a half like `MH 12` parses
     as a valid short plate — so a fragment beat the whole plate. The joined
     block is now a candidate in its own right, and short readings are
     discounted.
- The character whitelist passed to the recognition engine is gone. It reads
  like an easy win but the LSTM engine handles it badly; junk is cheaper to
  strip afterwards, which the normaliser already did.

### Added

- When a scan fails, the app now shows **what the camera actually read**, so a
  bad angle or a misframed box is obvious instead of being a dead end.
- Three tests covering two-row plates, so a fragment can never again outscore
  the plate it came from.

## [2.0.0] - 2026-08-25

Onboarding is now a link and a name. Nothing else.

### Changed

- **Members no longer type a club code.** It travels in the invite link
  (`https://your-address/#join=YOURCODE`), is remembered on first open, and is
  wiped from the address bar so it does not sit in a screenshot. A member types
  their name once and starts tagging. The gate still exists — someone opening
  the bare address cannot join — it is simply invisible to the people who
  belong there.
- **No more admins.** A club of friends does not need two tiers, and with
  nobody typing codes there was no way to become one. Any member can now remove
  any tag, which is what you want when the person who made the mistake is not
  around, and anyone can download the CSV export.
- **The undo window is gone.** A tag was previously removable by its author for
  24 hours; now any member can remove any tag at any time.

### Added

- **Your own tally on the scan screen** — how many you have tagged, next to the
  club total, updating live as tags land, including tags other members make
  while your phone is open.
- A hidden **"I was given a code"** fallback on the sign-in screen, for when a
  chat app strips the `#join=...` off a shared link.

### Removed

- `ADMIN_CODE` and `UNDO_WINDOW_MS` settings, and the `is_admin` column. A
  database from 1.x keeps working; the column is simply ignored.

## [1.1.0] - 2026-08-25

Adds a way to run TagCheck with no server and no cost.

### Added

- **Firebase backend.** Point the app at a Firestore project and it runs
  serverless: Google hosts the app and holds the club records, free at club
  scale, with HTTPS included (which iOS requires before it will hand a web page
  the camera). See [docs/FIREBASE.md](docs/FIREBASE.md).
- **Security rules carrying the duplicate guarantee.** A tag document is keyed
  by the plate and rules allow `create` but never `update`, so a second member
  tagging one bike is refused by Firestore itself — the same protection the
  SQLite unique index gives.
- **25 security rule tests** run against the Firestore emulator, covering
  joining, admin promotion, tag immutability, the undo window, and the
  duplicate guarantee. CI runs them on every push.
- **Pluggable backends.** `web/backend.js` picks Firestore or a TagCheck server
  from one config value; the rest of the app is identical either way.
- `npm run build:web` assembles the deployable site, and `npm run firebase:deploy`
  ships rules and app together.

### Changed

- Offline support on Firebase comes from Firestore's own persistence, which
  replaces the hand-rolled mirror for that backend. Tags made offline are still
  reconciled afterwards, so a lost race is reported rather than silently
  dropped.
- `npm test` now targets the server suite explicitly, so it no longer needs an
  emulator to be running.
- Content Security Policy allows the Firebase SDK and endpoints, so the
  serverless setup also works when the app is served from the Node server.

### Fixed

- The **Remove this tag** button could stay visible after a tag was undone, on a
  bike that was then free.

## [1.0.0] - 2026-08-25

First working release: enough to run a real tagging drive.

### Added

- **Plate scanning** from the phone camera, from a photo, or typed by hand.
  The guide box on screen is what gets cropped and read, so members aim rather
  than hope.
- **Duplicate check before tagging.** Every plate resolves to one canonical
  form, so `MH 12 AB 1234`, `mh12ab1234` and `MH-12-AB-1234` are one bike.
- **Near-match warnings.** Plates one camera-confusable character apart are
  surfaced side by side instead of silently becoming a second tag.
- **A database-level guarantee.** A unique index on the active plate means two
  phones tagging the same bike in the same second cannot both win.
- **Offline use.** The app keeps a mirror of every tagged plate, answers
  lookups from it with no signal, and queues tags for replay on reconnect.
  Replays are idempotent, so a flaky network never doubles a tag.
- **Undo.** Members can remove their own tag for 24 hours; admins can remove
  any tag. An untagged bike becomes taggable again.
- **Recent tags, totals and a leaderboard**, plus a CSV export for admins.
- **Installs to the home screen** on iOS and Android as a progressive web app.
- **Self-hosted recognition option** via `npm run vendor:ocr`, for clubs that
  would rather not call a CDN.
- Docker image, compose file, and CI across Node 22 and 24.

[2.1.0]: https://github.com/Mistique707/tagcheck/releases/tag/v2.1.0
[2.0.2]: https://github.com/Mistique707/tagcheck/releases/tag/v2.0.2
[2.0.1]: https://github.com/Mistique707/tagcheck/releases/tag/v2.0.1
[2.0.0]: https://github.com/Mistique707/tagcheck/releases/tag/v2.0.0
[1.1.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.1.0
[1.0.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.0.0
