# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.1.0
[1.0.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.0.0
