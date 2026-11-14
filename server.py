#!/usr/bin/env python3
"""Hanging Clozet shared server.

Serves the static app, a SQLite-backed account/closet/admin API, and the image
link resolver.

Local:      python server.py
Deployed:   PORT=8000 DATA_DIR=/data python server.py
"""

import base64
import gzip
import hashlib
import hmac
import html
import ipaddress
import json
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("DATA_DIR") or os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "hanging-clozet.db")

PBKDF2_ITERATIONS = 150000
SESSION_MS = 30 * 24 * 60 * 60 * 1000
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD") or "Hamaadkhan123@"
MAX_BODY = 30 * 1024 * 1024
MAX_ITEMS = 600

CATEGORIES = {"shirt", "pants", "suit", "shoes", "accessory"}
COLORS = {
    "black", "grey", "cream", "camel", "brown", "navy", "denim", "blue",
    "teal", "green", "olive", "mustard", "orange", "maroon", "red", "pink",
    "purple",
}
USERNAME_RE = re.compile(r"^[a-z0-9._-]{3,24}$")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
IMAGE_TYPES = {
    "image/jpeg", "image/png", "image/webp", "image/gif", "image/avif",
    "image/bmp",
}
GOOGLE_HOST = re.compile(r"(^|\.)google\.[a-z.]+$", re.I)
BING_HOST = re.compile(r"(^|\.)bing\.[a-z.]+$", re.I)
DDG_HOST = re.compile(r"(^|\.)duckduckgo\.com$", re.I)


class ApiError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code = code
        self.status = status


# --------------------------------------------------------------------------
# database
# --------------------------------------------------------------------------

def now_ms():
    return int(time.time() * 1000)


def new_id(prefix):
    return prefix + "_" + secrets.token_hex(9)


def db():
    conn = sqlite3.connect(DB_PATH, timeout=15, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    return conn


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, exc_type, exc, traceback):
        try:
            return super().__exit__(exc_type, exc, traceback)
        finally:
            self.close()


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                username TEXT NOT NULL UNIQUE,
                role TEXT NOT NULL DEFAULT 'user',
                disabled INTEGER NOT NULL DEFAULT 0,
                default_password INTEGER NOT NULL DEFAULT 0,
                salt TEXT NOT NULL,
                hash TEXT NOT NULL,
                iterations INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS items (
                id TEXT NOT NULL,
                account_id TEXT NOT NULL,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                color TEXT NOT NULL,
                image_kind TEXT NOT NULL,
                image_value TEXT NOT NULL,
                favorite INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (account_id, id)
            );
            CREATE INDEX IF NOT EXISTS items_account ON items(account_id);
            CREATE TABLE IF NOT EXISTS audit (
                id TEXT PRIMARY KEY,
                ts INTEGER NOT NULL,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                actor TEXT NOT NULL
            );
            """
        )
        seed_admin(conn)


def derive(password, salt_b64=None, iterations=PBKDF2_ITERATIONS):
    salt = base64.b64decode(salt_b64) if salt_b64 else secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, 32)
    return base64.b64encode(salt).decode("ascii"), base64.b64encode(digest).decode("ascii")


def verify(password, salt_b64, expected_b64, iterations):
    _, digest = derive(password, salt_b64, iterations)
    return hmac.compare_digest(digest, expected_b64)


def seed_admin(conn):
    row = conn.execute("SELECT * FROM accounts WHERE username = ?", (ADMIN_USERNAME,)).fetchone()
    if row is None:
        salt, digest = derive(ADMIN_PASSWORD)
        conn.execute(
            "INSERT INTO accounts (id, name, username, role, disabled, default_password, salt, hash, iterations, created_at)"
            " VALUES (?, ?, ?, 'admin', 0, 1, ?, ?, ?, ?)",
            (new_id("u"), "Clozet Admin", ADMIN_USERNAME, salt, digest, PBKDF2_ITERATIONS, now_ms()),
        )
        log_event(conn, "admin.seed", "Default administrator created", "system")
    elif row["default_password"]:
        salt, digest = derive(ADMIN_PASSWORD)
        conn.execute(
            "UPDATE accounts SET salt = ?, hash = ?, iterations = ?, default_password = 1 WHERE id = ?",
            (salt, digest, PBKDF2_ITERATIONS, row["id"]),
        )


def log_event(conn, kind, message, actor):
    conn.execute(
        "INSERT INTO audit (id, ts, kind, message, actor) VALUES (?, ?, ?, ?, ?)",
        (new_id("e"), now_ms(), str(kind), str(message), str(actor)),
    )
    conn.execute(
        "DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY ts DESC LIMIT 300)"
    )


def find_account(conn, *, uid=None, username=None):
    if uid is not None:
        return conn.execute("SELECT * FROM accounts WHERE id = ?", (uid,)).fetchone()
    return conn.execute("SELECT * FROM accounts WHERE username = ?", (username,)).fetchone()


def public_account(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "username": row["username"],
        "role": row["role"],
        "disabled": bool(row["disabled"]),
        "defaultPassword": bool(row["default_password"]),
        "createdAt": row["created_at"],
    }


def item_stats(conn, uid):
    rows = conn.execute(
        "SELECT category, favorite, length(image_value) AS n FROM items WHERE account_id = ?",
        (uid,),
    ).fetchall()
    pieces = len(rows)
    favorites = sum(1 for row in rows if row["favorite"])
    shirts = sum(1 for row in rows if row["category"] == "shirt")
    pants = sum(1 for row in rows if row["category"] == "pants")
    return {
        "pieces": pieces,
        "favorites": favorites,
        "looks": shirts * pants,
        "bytes": sum((row["n"] or 0) * 2 for row in rows),
    }


def admin_account(conn, row):
    data = public_account(row)
    data["stats"] = item_stats(conn, row["id"])
    data["password"] = {
        "algorithm": "PBKDF2-SHA256",
        "iterations": row["iterations"],
        "hashPrefix": (row["hash"][:12] + "…") if row["hash"] else "—",
    }
    return data


def active_admins(conn):
    return conn.execute(
        "SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND disabled = 0"
    ).fetchone()["n"]


def create_session(conn, uid):
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (now_ms(),))
    conn.execute(
        "INSERT INTO sessions (token, account_id, expires_at) VALUES (?, ?, ?)",
        (token, uid, now_ms() + SESSION_MS),
    )
    return token


def session_account(conn, token):
    if not token:
        return None
    row = conn.execute(
        "SELECT a.* FROM sessions s JOIN accounts a ON a.id = s.account_id "
        "WHERE s.token = ? AND s.expires_at > ?",
        (token, now_ms()),
    ).fetchone()
    if row is None or row["disabled"]:
        return None
    return row


def delete_sessions(conn, uid):
    conn.execute("DELETE FROM sessions WHERE account_id = ?", (uid,))


# --------------------------------------------------------------------------
# items
# --------------------------------------------------------------------------

def clean_item(raw, existing_ids):
    if not isinstance(raw, dict):
        return None
    category = str(raw.get("category", ""))
    color = str(raw.get("color", ""))
    if category not in CATEGORIES or color not in COLORS:
        return None

    image = raw.get("image")
    if not isinstance(image, dict):
        return None
    kind = str(image.get("kind", ""))
    value = str(image.get("value", ""))
    if kind not in ("data", "url") or not value:
        return None
    if kind == "data":
        if not value.startswith("data:image/") or len(value) > 14 * 1024 * 1024:
            return None
    else:
        if not re.match(r"^https?://", value, re.I) or len(value) > 2048:
            return None

    uid = str(raw.get("id") or "")
    if not uid or uid in existing_ids:
        uid = new_id("i")
    existing_ids.add(uid)

    try:
        favorite = 1 if raw.get("favorite") else 0
    except Exception:
        favorite = 0
    try:
        created = int(raw.get("createdAt") or now_ms())
    except Exception:
        created = now_ms()

    name = str(raw.get("name", "")).strip()[:80] or category.capitalize()
    return {
        "id": uid,
        "name": name,
        "category": category,
        "color": color,
        "image_kind": kind,
        "image_value": value,
        "favorite": favorite,
        "created_at": created,
    }


def replace_items(conn, uid, items):
    if not isinstance(items, list):
        raise ApiError("invalid-items", "Items must be a list.")
    if len(items) > MAX_ITEMS:
        raise ApiError("too-many-items", "That closet has too many pieces.")

    seen = set()
    cleaned = [item for item in (clean_item(raw, seen) for raw in items) if item is not None]

    conn.execute("DELETE FROM items WHERE account_id = ?", (uid,))
    conn.executemany(
        "INSERT INTO items (id, account_id, name, category, color, image_kind, image_value, favorite, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (i["id"], uid, i["name"], i["category"], i["color"], i["image_kind"],
             i["image_value"], i["favorite"], i["created_at"])
            for i in cleaned
        ],
    )
    return list_items(conn, uid)


def item_json(row):
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "color": row["color"],
        "image": {"kind": row["image_kind"], "value": row["image_value"]},
        "favorite": bool(row["favorite"]),
        "createdAt": row["created_at"],
    }


def list_items(conn, uid):
    rows = conn.execute(
        "SELECT * FROM items WHERE account_id = ? ORDER BY created_at DESC", (uid,)
    ).fetchall()
    return [item_json(row) for row in rows]


# --------------------------------------------------------------------------
# image resolver
# --------------------------------------------------------------------------

class ResolveError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def is_public_host(host):
    if not host:
        return False
    name = host.strip("[]").lower()
    if name in ("localhost",) or name.endswith(".local") or name.endswith(".internal"):
        return False
    try:
        infos = socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local or
                ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def check_url(url):
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        raise ResolveError("invalid-url", "That is not a valid link.")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ResolveError("invalid-url", "Only http and https links are supported.")
    if not is_public_host(parts.hostname):
        raise ResolveError("blocked-host", "That host is not reachable from this app.")


def http_get(url):
    check_url(url)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,text/html;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "identity",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=18) as response:
            final_url = response.geturl()
            check_url(final_url)
            content_type = (response.headers.get("Content-Type") or "").lower()
            encoding = (response.headers.get("Content-Encoding") or "").lower()
            data = response.read(12 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as exc:
        raise ResolveError("fetch-failed", "The site refused the request (%s)." % exc.code)
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ResolveError("fetch-failed", "Could not reach that site.")

    if len(data) > 12 * 1024 * 1024:
        raise ResolveError("too-large", "That image is larger than 12 MB.")
    if encoding == "gzip":
        try:
            data = gzip.decompress(data)
        except OSError:
            raise ResolveError("fetch-failed", "Could not decode that response.")
    elif encoding == "deflate":
        try:
            data = zlib.decompress(data)
        except zlib.error:
            raise ResolveError("fetch-failed", "Could not decode that response.")

    mime = content_type.split(";")[0].strip() or "application/octet-stream"
    charset = "utf-8"
    match = re.search(r"charset=([\w.-]+)", content_type)
    if match:
        charset = match.group(1)
    return mime, charset, data, final_url


def decode_twice(value):
    candidate = value.strip()
    for _ in range(2):
        if not re.match(r"^https?%3a", candidate, re.I):
            break
        try:
            candidate = urllib.parse.unquote(candidate)
        except ValueError:
            break
    return candidate


def extract_target(url):
    try:
        parts = urllib.parse.urlsplit(url)
        query = urllib.parse.parse_qs(parts.query)
    except ValueError:
        return url
    host = (parts.hostname or "").lower()
    keys = []
    if GOOGLE_HOST.search(host):
        keys = ["imgurl", "mediaurl", "url"]
    elif BING_HOST.search(host):
        keys = ["mediaurl", "imgurl"]
    elif DDG_HOST.search(host):
        keys = ["u"]
    for key in keys:
        values = query.get(key)
        if values:
            candidate = decode_twice(values[0])
            if candidate.startswith(("http://", "https://")):
                return candidate
    return url


def find_page_image(text, base_url):
    patterns = (
        r'<meta[^>]+(?:property|name)=["\'](?:og:image|og:image:url|og:image:secure_url|twitter:image|twitter:image:src)["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\'](?:og:image|twitter:image)["\']',
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, re.I):
            candidate = html.unescape(match.group(1)).strip()
            if candidate.startswith("//"):
                candidate = "https:" + candidate
            elif candidate.startswith("/"):
                candidate = urllib.parse.urljoin(base_url, candidate)
            if candidate.startswith(("http://", "https://")):
                return candidate
    for match in re.finditer(r'<img[^>]+(?:src|data-src)=["\']([^"\']+)', text, re.I):
        candidate = html.unescape(match.group(1)).strip()
        if candidate.startswith("//"):
            candidate = "https:" + candidate
        elif candidate.startswith("/"):
            candidate = urllib.parse.urljoin(base_url, candidate)
        if not candidate.startswith(("http://", "https://")):
            continue
        if re.search(r"(sprite|logo|icon|pixel|avatar|badge)", candidate, re.I):
            continue
        return candidate
    return None


def to_data_url(mime, data):
    if mime not in IMAGE_TYPES:
        raise ResolveError("unsupported-image", "That file type cannot be used as a photo.")
    return "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii"))


def resolve_image(raw_url):
    url = (raw_url or "").strip()
    if not url:
        raise ResolveError("missing-url", "Paste an image or page link first.")
    if url.startswith("data:image/"):
        return {"ok": True, "image": url, "source": "inline"}

    target = extract_target(url)
    mime, charset, data, final_url = http_get(target)
    if mime in IMAGE_TYPES:
        return {"ok": True, "image": to_data_url(mime, data), "source": final_url}

    if mime in ("text/html", "application/xhtml+xml", "text/plain"):
        if len(data) > 3 * 1024 * 1024:
            data = data[: 3 * 1024 * 1024]
        text = data.decode(charset, "replace")
        if GOOGLE_HOST.search((urllib.parse.urlsplit(final_url).hostname or "").lower()):
            found = re.search(r'[?&](?:imgurl|mediaurl)=([^&"\'<>\\]+)', text)
            if found:
                candidate = decode_twice(html.unescape(found.group(1)))
                if candidate.startswith(("http://", "https://")):
                    mime2, charset2, data2, final2 = http_get(candidate)
                    return {"ok": True, "image": to_data_url(mime2, data2), "source": final2}
        candidate = find_page_image(text, final_url)
        if not candidate:
            raise ResolveError("no-image", "That page has no main photo.")
        mime2, charset2, data2, final2 = http_get(candidate)
        return {"ok": True, "image": to_data_url(mime2, data2), "source": final2}

    raise ResolveError("not-image", "That link is not an image or an image page.")


# --------------------------------------------------------------------------
# HTTP handler
# --------------------------------------------------------------------------

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
        self.send_header("Vary", "Origin")

    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ApiError("invalid-body", "Invalid request.")
        if length > MAX_BODY:
            raise ApiError("too-large", "That request is too large.", 413)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError("invalid-json", "Invalid request.")
        if not isinstance(payload, dict):
            raise ApiError("invalid-json", "Invalid request.")
        return payload

    def bearer(self):
        header = self.headers.get("Authorization") or ""
        if not header.lower().startswith("bearer "):
            return ""
        return header[7:].strip()

    def get_account(self, conn, admin=False):
        row = session_account(conn, self.bearer())
        if row is None:
            raise ApiError("unauthorized", "Please sign in again.", 401)
        if admin and row["role"] != "admin":
            raise ApiError("forbidden", "Administrator access required.", 403)
        return row

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path
        query = urllib.parse.parse_qs(parts.query)

        try:
            if path == "/api/health":
                self.send_json(200, {"ok": True, "service": "hanging-clozet", "version": 2})
                return

            if path == "/api/ping":
                self.send_json(200, {"ok": True, "service": "ember-resolver"})
                return

            if path == "/api/resolve":
                target = (query.get("url") or [""])[0]
                try:
                    result = resolve_image(target)
                except ResolveError as exc:
                    self.send_json(200, {"ok": False, "error": exc.code, "message": str(exc)})
                except Exception:
                    self.send_json(200, {"ok": False, "error": "resolve-failed", "message": "Could not resolve that link."})
                else:
                    self.send_json(200, result)
                return

            if path == "/api/image":
                target = (query.get("url") or [""])[0]
                try:
                    mime, charset, data, final_url = http_get(target)
                    if mime not in IMAGE_TYPES:
                        raise ResolveError("not-image", "That link is not an image.")
                except ResolveError as exc:
                    self.send_json(502, {"ok": False, "error": exc.code, "message": str(exc)})
                    return
                self.send_response(200)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_cors()
                self.end_headers()
                self.wfile.write(data)
                return

            if path == "/api/auth/session":
                with db() as conn:
                    row = self.get_account(conn)
                    self.send_json(200, {
                        "ok": True,
                        "account": public_account(row),
                        "items": list_items(conn, row["id"]),
                    })
                return

            if path == "/api/items":
                with db() as conn:
                    row = self.get_account(conn)
                    self.send_json(200, {"ok": True, "items": list_items(conn, row["id"])})
                return

            if path == "/api/admin/accounts":
                with db() as conn:
                    self.get_account(conn, admin=True)
                    rows = conn.execute("SELECT * FROM accounts ORDER BY created_at ASC").fetchall()
                    self.send_json(200, {"ok": True, "accounts": [admin_account(conn, row) for row in rows]})
                return

            match = re.match(r"^/api/admin/accounts/([^/]+)/items$", path)
            if match:
                with db() as conn:
                    self.get_account(conn, admin=True)
                    target = find_account(conn, uid=urllib.parse.unquote(match.group(1)))
                    if target is None:
                        raise ApiError("not-found", "Account not found.", 404)
                    self.send_json(200, {"ok": True, "items": list_items(conn, target["id"])})
                return

            match = re.match(r"^/api/admin/accounts/([^/]+)$", path)
            if match:
                with db() as conn:
                    self.get_account(conn, admin=True)
                    target = find_account(conn, uid=urllib.parse.unquote(match.group(1)))
                    if target is None:
                        raise ApiError("not-found", "Account not found.", 404)
                    self.send_json(200, {"ok": True, "account": admin_account(conn, target)})
                return

            if path == "/api/admin/audit":
                with db() as conn:
                    self.get_account(conn, admin=True)
                    rows = conn.execute("SELECT * FROM audit ORDER BY ts DESC LIMIT 300").fetchall()
                    self.send_json(200, {"ok": True, "events": [
                        {"id": row["id"], "ts": row["ts"], "kind": row["kind"],
                         "message": row["message"], "actor": row["actor"]}
                        for row in rows
                    ]})
                return

            if path == "/api/admin/export":
                with db() as conn:
                    self.get_account(conn, admin=True)
                    accounts = conn.execute("SELECT * FROM accounts ORDER BY created_at ASC").fetchall()
                    wardrobes = {row["id"]: list_items(conn, row["id"]) for row in accounts}
                    events = conn.execute("SELECT * FROM audit ORDER BY ts DESC LIMIT 300").fetchall()
                    self.send_json(200, {
                        "ok": True,
                        "export": {
                            "app": "hanging-clozet",
                            "version": 2,
                            "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                            "accounts": [admin_account(conn, row) for row in accounts],
                            "wardrobes": wardrobes,
                            "events": [
                                {"id": row["id"], "ts": row["ts"], "kind": row["kind"],
                                 "message": row["message"], "actor": row["actor"]}
                                for row in events
                            ],
                        },
                    })
                return

            blocked = (
                "/server.py", "/README.md", "/Dockerfile", "/render.yaml",
                "/.gitignore", "/.dockerignore", "/.env", "/run.bat",
            )
            if (path in blocked or path == "/data" or path.startswith("/data/")
                    or path.endswith(".db")):
                self.send_error(404)
                return

            super().do_GET()
        except ApiError as exc:
            self.send_json(exc.status, {"ok": False, "error": exc.code, "message": str(exc)})
        except Exception:
            self.send_json(500, {"ok": False, "error": "server-error", "message": "Server error."})

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/api/auth/signup":
                self.handle_signup()
            elif path == "/api/auth/login":
                self.handle_login()
            elif path == "/api/auth/logout":
                self.handle_logout()
            elif path == "/api/auth/password":
                self.handle_password()
            elif path == "/api/admin/clear-closets":
                with db() as conn:
                    admin = self.get_account(conn, admin=True)
                    count = conn.execute("SELECT COUNT(*) AS n FROM items").fetchone()["n"]
                    conn.execute("DELETE FROM items")
                    log_event(conn, "admin.purge", "Cleared %d piece(s) from every closet" % count, admin["username"])
                    self.send_json(200, {"ok": True, "removed": count})
            elif re.match(r"^/api/admin/accounts/([^/]+)/password$", path):
                self.handle_admin_password(path)
            elif re.match(r"^/api/admin/accounts/([^/]+)/disabled$", path):
                self.handle_admin_disabled(path)
            else:
                self.send_json(404, {"ok": False, "error": "not-found", "message": "Not found."})
        except ApiError as exc:
            self.send_json(exc.status, {"ok": False, "error": exc.code, "message": str(exc)})
        except Exception:
            self.send_json(500, {"ok": False, "error": "server-error", "message": "Server error."})

    def do_PUT(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            if path == "/api/items":
                payload = self.read_json()
                with db() as conn:
                    row = self.get_account(conn)
                    items = replace_items(conn, row["id"], payload.get("items"))
                    self.send_json(200, {"ok": True, "items": items})
            else:
                self.send_json(404, {"ok": False, "error": "not-found", "message": "Not found."})
        except ApiError as exc:
            self.send_json(exc.status, {"ok": False, "error": exc.code, "message": str(exc)})
        except Exception:
            self.send_json(500, {"ok": False, "error": "server-error", "message": "Server error."})

    def do_DELETE(self):
        path = urllib.parse.urlsplit(self.path).path
        try:
            match = re.match(r"^/api/admin/accounts/([^/]+)/items/([^/]+)$", path)
            if match:
                with db() as conn:
                    admin = self.get_account(conn, admin=True)
                    target = find_account(conn, uid=urllib.parse.unquote(match.group(1)))
                    if target is None:
                        raise ApiError("not-found", "Account not found.", 404)
                    item_id = urllib.parse.unquote(match.group(2))
                    conn.execute("DELETE FROM items WHERE id = ? AND account_id = ?", (item_id, target["id"]))
                    log_event(conn, "admin.item.delete",
                              "Removed a piece from @%s's closet" % target["username"], admin["username"])
                    self.send_json(200, {"ok": True, "items": list_items(conn, target["id"])})
                return

            match = re.match(r"^/api/admin/accounts/([^/]+)$", path)
            if match:
                with db() as conn:
                    admin = self.get_account(conn, admin=True)
                    target = find_account(conn, uid=urllib.parse.unquote(match.group(1)))
                    if target is None:
                        raise ApiError("not-found", "Account not found.", 404)
                    if target["role"] == "admin" and active_admins(conn) <= 1:
                        raise ApiError("last-admin", "At least one active administrator is required.", 409)
                    conn.execute("DELETE FROM items WHERE account_id = ?", (target["id"],))
                    delete_sessions(conn, target["id"])
                    conn.execute("DELETE FROM accounts WHERE id = ?", (target["id"],))
                    log_event(conn, "admin.delete", "Deleted account @%s" % target["username"], admin["username"])
                    self.send_json(200, {"ok": True})
                return

            self.send_json(404, {"ok": False, "error": "not-found", "message": "Not found."})
        except ApiError as exc:
            self.send_json(exc.status, {"ok": False, "error": exc.code, "message": str(exc)})
        except Exception:
            self.send_json(500, {"ok": False, "error": "server-error", "message": "Server error."})

    def handle_signup(self):
        payload = self.read_json()
        name = str(payload.get("name", "")).strip()[:60]
        username = str(payload.get("username", "")).strip().lower()
        password = str(payload.get("password", ""))

        if username == ADMIN_USERNAME:
            raise ApiError("reserved-username", "That username is reserved.", 409)
        if not USERNAME_RE.match(username):
            raise ApiError("invalid-username", "Usernames need 3–24 characters.")
        if len(password) < 8:
            raise ApiError("weak-password", "Passwords need at least 8 characters.")

        with db() as conn:
            if find_account(conn, username=username):
                raise ApiError("username-taken", "That username is already taken.", 409)
            salt, digest = derive(password)
            uid = new_id("u")
            conn.execute(
                "INSERT INTO accounts (id, name, username, role, disabled, default_password, salt, hash, iterations, created_at)"
                " VALUES (?, ?, ?, 'user', 0, 0, ?, ?, ?, ?)",
                (uid, name or username, username, salt, digest, PBKDF2_ITERATIONS, now_ms()),
            )
            token = create_session(conn, uid)
            row = find_account(conn, uid=uid)
            log_event(conn, "auth.signup", "New account @%s created" % username, username)
            self.send_json(200, {
                "ok": True, "token": token,
                "account": public_account(row), "items": [],
            })

    def handle_login(self):
        payload = self.read_json()
        username = str(payload.get("username", "")).strip().lower()
        password = str(payload.get("password", ""))

        with db() as conn:
            row = find_account(conn, username=username)
            if row is None or not verify(password, row["salt"], row["hash"], row["iterations"]):
                raise ApiError("invalid-credentials", "That username and password don't match.", 401)
            if row["disabled"]:
                raise ApiError("account-disabled", "That account has been disabled.", 403)
            token = create_session(conn, row["id"])
            log_event(conn, "auth.login", "Signed in as @%s" % username, username)
            self.send_json(200, {
                "ok": True, "token": token,
                "account": public_account(row), "items": list_items(conn, row["id"]),
            })

    def handle_logout(self):
        token = self.bearer()
        if token:
            with db() as conn:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
        self.send_json(200, {"ok": True})

    def handle_password(self):
        payload = self.read_json()
        current = str(payload.get("currentPassword", ""))
        new = str(payload.get("newPassword", ""))
        if len(new) < 8:
            raise ApiError("weak-password", "Use at least 8 characters.")
        with db() as conn:
            row = self.get_account(conn)
            if not verify(current, row["salt"], row["hash"], row["iterations"]):
                raise ApiError("invalid-credentials", "That current password is incorrect.", 401)
            salt, digest = derive(new)
            conn.execute(
                "UPDATE accounts SET salt = ?, hash = ?, iterations = ?, default_password = 0 WHERE id = ?",
                (salt, digest, PBKDF2_ITERATIONS, row["id"]),
            )
            delete_sessions(conn, row["id"])
            token = create_session(conn, row["id"])
            log_event(conn, "auth.password", "Password changed", row["username"])
            self.send_json(200, {"ok": True, "token": token})

    def handle_admin_password(self, path):
        match = re.match(r"^/api/admin/accounts/([^/]+)/password$", path)
        payload = self.read_json()
        with db() as conn:
            admin = self.get_account(conn, admin=True)
            target = find_account(conn, uid=urllib.parse.unquote(match.group(1)))
            if target is None:
                raise ApiError("not-found", "Account not found.", 404)
            password = str(payload.get("password", ""))
            if len(password) < 8:
                raise ApiError("weak-password", "Use at least 8 characters.")
            salt, digest = derive(password)
            conn.execute(
                "UPDATE accounts SET salt = ?, hash = ?, iterations = ?, default_password = 0 WHERE id = ?",
                (salt, digest, PBKDF2_ITERATIONS, target["id"]),
            )
            delete_sessions(conn, target["id"])
            log_event(conn, "admin.password", "Password reset for @%s" % target["username"], admin["username"])
            self.send_json(200, {"ok": True})

    def handle_admin_disabled(self, path):
        match = re.match(r"^/api/admin/accounts/([^/]+)/disabled$", path)
        payload = self.read_json()
        with db() as conn:
            admin = self.get_account(conn, admin=True)
            target = find_account(conn, uid=urllib.parse.unquote(match.group(1)))
            if target is None:
                raise ApiError("not-found", "Account not found.", 404)
            disabled = bool(payload.get("disabled"))
            if disabled and target["role"] == "admin" and active_admins(conn) <= 1:
                raise ApiError("last-admin", "At least one active administrator is required.", 409)
            conn.execute("UPDATE accounts SET disabled = ? WHERE id = ?", (1 if disabled else 0, target["id"]))
            if disabled:
                delete_sessions(conn, target["id"])
            log_event(conn, "admin." + ("disable" if disabled else "enable"),
                      ("Disabled" if disabled else "Re-enabled") + " account @%s" % target["username"],
                      admin["username"])
            self.send_json(200, {"ok": True})


def probe_8000(host):
    try:
        with urllib.request.urlopen("http://%s:8000/" % host, timeout=1.5) as response:
            return response.read(40000).decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        try:
            return exc.read(40000).decode("utf-8", "replace")
        except Exception:
            return ""
    except Exception:
        return None


def port_8000_busy():
    return any(probe_8000(host) is not None for host in ("localhost", "127.0.0.1"))


def app_on_8000():
    for host in ("localhost", "127.0.0.1"):
        text = probe_8000(host)
        if text and ("assets/js/theme.js" in text or "Hanging Clozet" in text):
            return True
    return False


def main():
    init_db()
    port_env = os.environ.get("PORT")

    if port_env:
        host = "0.0.0.0"
        port = int(port_env)
        server = ThreadingHTTPServer((host, port), Handler)
        print("Hanging Clozet server on %s:%d (shared accounts enabled)" % (host, port))
    else:
        requested = 8000
        if len(sys.argv) > 1:
            try:
                requested = int(sys.argv[1])
            except ValueError:
                requested = 8000

        if requested == 8000 and port_8000_busy():
            requested = 8001

        server = None
        port = requested
        for port in range(requested, requested + 20):
            try:
                server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
                break
            except OSError:
                continue
        if server is None:
            print("No free port found.")
            return 1

        attach = port != 8000 and app_on_8000()
        if attach:
            print("The app is already served at http://localhost:8000/index.html")
            print("Shared account server is running on port %d." % port)
            print("Reload the localhost:8000 tab — accounts will now sync across devices.")
        else:
            url = "http://localhost:%d/index.html" % port
            print("Hanging Clozet is running at %s" % url)
            print("Shared accounts are enabled. Close this window to stop the server.")
            threading.Timer(0.7, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
