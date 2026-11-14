# Hanging Clozet

A local-first wardrobe organiser. Catalogue what you own, keep photos in the
browser, and see every shirt-and-trouser pairing ranked by colour harmony.

## Run locally

Double-click `run.bat` (Windows) or run:

```bash
python server.py
```

`server.py` serves the app and resolves image links the browser cannot fetch
on its own (Google/Bing result links, pages with an `og:image`, and images that
block hotlinking). It prefers port 8000 and opens the app automatically.

If the app is already being served at `http://localhost:8000`, the launcher
starts the resolver beside it and asks you to reload that tab, so your existing
closet data stays on the same origin.

## Admin

- Address: `admin.html`
- Username: `admin`
- Sign in with the administrator password supplied with the project, then change it from **My account**.

The admin console is a local browser-only gateway, not server-side
authentication — it manages the accounts and closets stored in that browser.
Click any account row (or **Details**) to see every stored account field,
password hash fingerprint, closet stats and recent activity. Passwords are
hashed with PBKDF2-SHA256 and cannot be displayed; use **Reset password** to
set a known one.

The admin lists accounts created in the same browser and at the same address
(origin). Registrations made in another browser or on another device are
stored there and cannot appear here — there is no shared account server.

## Themes

The default is **Amber Day**, a flat warm palette (cream paper, terracotta,
olive and mustard). Four more options ship in the nav picker: Clay Sunset,
Olive Grove, Sandalwood, Espresso Brass and Forest Sage. The choice is saved in
`localStorage` and applies to every page. No gradients are used.

## Publishing

The static pages work on any host (GitHub Pages, Netlify, Cloudflare Pages,
plain web space). Keep the folder structure intact.

- The **image link resolver** (`/api/resolve`) is provided by `server.py` and
  therefore only works while that Python server is running. On a purely static
  host, uploads and direct image URLs still work; Google/Bing result-page links
  fall back to a clear message.
- Closet and account data is stored in the visitor's browser (`localStorage`),
  not on the server. Data is tied to the site origin, so moving the site to a
  new domain/port starts with an empty closet on that address. Use the wardrobe
  **Backup** button or the admin **Download backup** before moving.
- The built-in admin account is local to each browser; it is not a shared,
  server-side admin. Change the default password from **My account** before
  sharing the site.
- `robots.txt` excludes `admin.html` and the admin page carries `noindex`.
- `og:image` currently points at `assets/brand/og.png` relatively. Once the
  domain is known, make it absolute (for example
  `https://your-domain.com/assets/brand/og.png`) so social previews always
  resolve.

## Files

```
index.html              sign in / create account
wardrobe.html           closet grid, add/edit, backup + restore
combinations.html       ranked outfit pairings + today's pick
admin.html              local administrator console
404.html                branded not-found page
manifest.webmanifest    installable web app metadata
robots.txt
server.py               static server + image link resolver
run.bat                 Windows launcher
assets/brand/           logo + app icons + share image
assets/css/             theme tokens, admin, motion/responsive
assets/js/              data layer, pages, theme, splash/cursor
```

## Notes

- Photos are compressed to WebP in the browser and stored locally. Large
  closets can hit the browser storage limit; image links use less space.
- Passwords are hashed with PBKDF2-SHA256.
- The mobile, tablet and desktop layouts share the same token palette.
