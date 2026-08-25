# Deploying TagCheck

The app needs one thing your laptop cannot give it: **HTTPS**. iOS refuses a web
page the camera without it, and installing to the home screen needs it too. So
pick any option below that ends in a certificate.

You also need somewhere the SQLite file survives restarts. It is a single file;
back it up by copying it.

> **Not sure you want to host anything?** You do not have to. The Firebase
> setup runs the whole thing on Google's free tier with no server and no
> monthly cost, and HTTPS is included — see
> [FIREBASE.md](FIREBASE.md). The rest of this page is for running the
> Node server yourself.

---

## Option 1: Docker on a small server

The most predictable option, and the one that keeps your data on your own box.

```bash
cp .env.example .env
```

Edit `.env`, then:

```bash
docker compose up -d --build
```

The database lives in the `tagcheck-data` volume. Put a reverse proxy in front
for TLS — Caddy needs two lines:

```
tagcheck.example.com {
  reverse_proxy localhost:3000
}
```

Then set `TRUST_PROXY=1` so rate limiting sees real client addresses rather
than the proxy.

Back up the database with:

```bash
docker compose exec tagcheck sh -c "cp /app/data/tagcheck.db /app/data/backup.db"
```

---

## Option 2: A managed host

Any platform that runs a Node process and offers a persistent disk works —
Render, Railway, Fly.io and similar. The shape is always the same:

- **Build command:** `npm ci`
- **Start command:** `npm start`
- **Node version:** 24 (22.5 is the minimum)
- **Persistent disk:** mount it, then set `DB_FILE` to a path on it, e.g.
  `/data/tagcheck.db`
- **Environment:** `CLUB_NAME`, `JOIN_CODE`, `JWT_SECRET`, `TRUST_PROXY=1`

> **The disk is not optional.** On a platform with an ephemeral filesystem,
> every deploy and every restart wipes the tag history, and the whole point of
> the app goes with it. If a persistent disk is not available on your plan, use
> Docker on a small server instead.

---

## Option 3: App on GitHub Pages, server elsewhere

Useful when you want the app on free static hosting and only a tiny API to run.

1. In the repository: **Settings → Pages → Source: GitHub Actions**.
2. **Actions → Deploy app to GitHub Pages → Run workflow**.
3. Deploy the server somewhere with HTTPS (options 1 or 2).
4. On the server, set `CORS_ORIGIN` to the Pages URL, for example
   `https://mistique707.github.io`.
5. Members open the Pages URL with `#join=YOURCODE` on the end, expand
   **Connect to a different server**, and paste the server address once.

The split costs one extra step during onboarding. If that matters more than
free hosting, serve the app from the server itself and skip this.

---

## After deploying

Check the server is up:

```bash
curl -sf https://your-server/api/health
```

Then, on an actual phone:

- Open the invite link (the address with `#join=YOURCODE` on the end) and
  type a name.
- Add to home screen (Safari: Share → Add to Home Screen; Chrome: menu → Install).
- Press **Scan plate** and confirm the camera opens.
- Turn on flight mode and check that a lookup still answers from the copy on
  the phone, and that a tag made offline shows **Saved on this phone** and
  sends itself once signal returns.

That last check is the one worth doing before a large drive.

## Reading plates without a CDN

By default the recognition engine is fetched from jsDelivr the first time a
member scans. To serve it yourself instead — no third-party requests, and plate
reading keeps working with no signal:

```bash
npm run vendor:ocr
```

This downloads about 15 MB into `web/vendor/` (git-ignored). Restart the
server; the app prefers the local copy automatically.

## Rotating the join code

Change `JOIN_CODE` and restart. Members already signed in keep working, because
their tokens are signed with `JWT_SECRET`. To sign *everyone* out, change
`JWT_SECRET` instead.

## Upgrading

```bash
git pull && npm ci && docker compose up -d --build
```

The schema is created with `IF NOT EXISTS` on boot, so an existing database is
picked up as-is. Copy the `.db` file somewhere safe before a major upgrade
anyway.
