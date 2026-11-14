# Hanging Clozet

A wardrobe organiser with shared accounts and closets. Run it with the bundled
Python server, or host the static UI separately and point it at a deployed API.

**Why the distinction matters:** accounts and closets used to live only in each
browser's `localStorage`, so a registration on a phone could never appear in the
admin panel on a PC. The server in this folder now provides a shared SQLite
database, sessions and admin APIs; the UI syncs to it when reachable and falls
back to browser-local mode only when no API is available.

## Run locally

Double-click `run.bat` (Windows) or run:

```bash
python server.py
```

This starts the app, the shared account/closet API, and the image link resolver
on `http://localhost:8000` (or the next free port). The admin account is seeded
in `data/hanging-clozet.db` on first start.

If another static server already owns port 8000, the launcher starts the shared
backend beside it on 8001; the app on 8000 discovers it automatically. Use the
same address on every device for the same data.

## Deploy the shared backend (required for cross-device accounts)

### Option A — one service serves everything (recommended)

Deploy this whole folder to Render, Railway, Fly.io, a VPS, or any Python host:

```bash
PORT=8000 DATA_DIR=/data python server.py
```

- `PORT` — the port the platform gives you.
- `DATA_DIR` — a **persistent disk** path for `hanging-clozet.db`. Without a
  persistent volume, SQLite data is lost when the service redeploys/restarts.
- `ADMIN_PASSWORD` — optional; overrides the seeded admin password.
- `render.yaml` and the `Dockerfile` are included as starting points.

Open the service URL on every device. Accounts, closets and admin data are then
shared through the server, with no client configuration needed.

### Option B — keep the static site, add a separate API

1. Deploy `server.py` from this folder as its own Python service (with a
   persistent `DATA_DIR`).
2. Edit `assets/js/config.js`:

   ```js
   window.CLOZET_CONFIG = {
     apiBase: 'https://your-hanging-clozet-api.onrender.com'
   };
   ```

3. Redeploy the static site.
4. Open the site on several devices and register/login. The admin panel lists
   every server account, wherever it was created.

CORS is enabled on the API. Use HTTPS for both.

### If you only host static files

Static hosts (GitHub Pages, Netlify, Cloudflare Pages) cannot run `server.py`.
The app still works, but every visitor's account and closet are local to their
own browser and **will not appear in the admin panel on another device**. To get
cross-device accounts, deploy the Python service above and point `apiBase` at
it.

## Admin

- Address: `admin.html`
- Username: `admin`
- Default password: `Hamaadkhan123@` (seeded on the server; override with the
  `ADMIN_PASSWORD` environment variable).

Change it from **My account** after signing in. Click any account row (or
**Details**) to see every stored field, closet stats, password hash fingerprint
and recent activity. Passwords are stored as salted PBKDF2-SHA256 hashes and
cannot be displayed; use **Reset password** to set a known one.

The admin panel refreshes live, and marks new registrations with a **New**
badge and toast. Multiple administrator/device sessions are allowed.

## Themes

**Amber Day** is the default: flat cream paper, terracotta, olive and mustard.
Alternatives: Clay Sunset, Olive Grove, Sandalwood, Espresso Brass, Forest Sage.
The choice is saved per browser. No gradients are used.

## Files

```
index.html              sign in / create account
wardrobe.html           closet grid, add/edit, backup + restore
combinations.html       ranked outfit pairings + today's pick
admin.html              shared administrator console
404.html                branded not-found page
server.py               static server + SQLite accounts/items/admin + resolver
run.bat                 Windows launcher
render.yaml             Render blueprint
Dockerfile              container deployment
config.js               assets/js/config.js — API origin for static hosting
assets/brand/           logo + app icons + share image
assets/css/             theme tokens, admin, motion/responsive
assets/js/              data layer, pages, theme, splash/cursor
data/                   SQLite database (local default; never served)
```

## Notes

- Accounts and sessions use the server when available. Local mode is a fallback,
  not a sync mechanism.
- Existing browser-local accounts and closets are not automatically migrated to
  the server database. Users register again; the admin account is seeded by the
  server.
- Photos are compressed to WebP; server storage is SQLite, so use a persistent
  disk and backups.
- Passwords are hashed with PBKDF2-SHA256; session tokens are random and expire
  after 30 days.
- `robots.txt` excludes `admin.html`; the admin page also carries `noindex`.
- Set `og:image` to an absolute URL on your domain for reliable social previews.
- The image link resolver is part of `server.py`; on a purely static host only
  uploads and direct image URLs work.
