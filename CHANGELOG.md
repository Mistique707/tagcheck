# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[2.0.1]: https://github.com/Mistique707/tagcheck/releases/tag/v2.0.1
[2.0.0]: https://github.com/Mistique707/tagcheck/releases/tag/v2.0.0
[1.1.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.1.0
[1.0.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.0.0
