# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/Mistique707/tagcheck/releases/tag/v1.0.0
