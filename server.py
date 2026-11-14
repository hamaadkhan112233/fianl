#!/usr/bin/env python3
"""Hanging Clozet local server.

Serves the static app and resolves image links the browser alone cannot fetch:
Google/Bing image result pages, ordinary pages with an og:image, and images
that block hotlinking. Run with: python server.py [port]
"""

import base64
import gzip
import html
import ipaddress
import json
import os
import re
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
import zlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
MAX_BYTES = 12 * 1024 * 1024
MAX_HTML = 3 * 1024 * 1024
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
    "image/bmp",
}

GOOGLE_HOST = re.compile(r"(^|\.)google\.[a-z.]+$", re.I)
BING_HOST = re.compile(r"(^|\.)bing\.[a-z.]+$", re.I)
DDG_HOST = re.compile(r"(^|\.)duckduckgo\.com$", re.I)


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
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
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
    return parts


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
            data = response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as exc:
        raise ResolveError("fetch-failed", "The site refused the request (%s)." % exc.code)
    except urllib.error.URLError:
        raise ResolveError("fetch-failed", "Could not reach that site.")
    except TimeoutError:
        raise ResolveError("fetch-failed", "The site took too long to respond.")
    except OSError:
        raise ResolveError("fetch-failed", "Could not fetch that link.")

    if len(data) > MAX_BYTES:
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

    # Last resort: the first reasonably named <img> on the page.
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
        if len(data) > MAX_HTML:
            data = data[:MAX_HTML]
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
            raise ResolveError(
                "no-image",
                "That page has no main photo. Open the image itself and copy its address.",
            )

        mime2, charset2, data2, final2 = http_get(candidate)
        return {"ok": True, "image": to_data_url(mime2, data2), "source": final2}

    raise ResolveError("not-image", "That link is not an image or an image page.")


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def send_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
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

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        parts = urllib.parse.urlsplit(self.path)

        if parts.path == "/api/ping":
            self.send_json(200, {"ok": True, "service": "ember-resolver"})
            return

        if parts.path == "/api/resolve":
            query = urllib.parse.parse_qs(parts.query)
            target = (query.get("url") or [""])[0]
            try:
                result = resolve_image(target)
            except ResolveError as exc:
                self.send_json(200, {"ok": False, "error": exc.code, "message": str(exc)})
            except Exception:
                self.send_json(
                    200,
                    {
                        "ok": False,
                        "error": "resolve-failed",
                        "message": "Could not resolve that link.",
                    },
                )
            else:
                self.send_json(200, result)
            return

        if parts.path == "/api/image":
            query = urllib.parse.parse_qs(parts.query)
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

        super().do_GET()


def probe_8000(host):
    """Return the served HTML at host:8000, or None when nothing answers."""
    try:
        with urllib.request.urlopen("http://%s:8000/" % host, timeout=2) as response:
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
    """True when port 8000 already serves a copy of this app."""
    for host in ("localhost", "127.0.0.1"):
        text = probe_8000(host)
        if text and ("assets/js/theme.js" in text or "Hanging Clozet" in text):
            return True
    return False


def main():
    requested = 8000
    if len(sys.argv) > 1:
        try:
            requested = int(sys.argv[1])
        except ValueError:
            requested = 8000

    # Never split 8000 between IPv4 and IPv6: if anything already answers there,
    # serve the resolver on the next port and let the existing page attach to it.
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
        print("No free port found between %s and %s." % (requested, requested + 19))
        return 1

    attach = port != 8000 and app_on_8000()

    if attach:
        print("The wardrobe app is already served at http://localhost:8000/index.html")
        print("Resolver is running on port %d." % port)
        print("Reload your localhost:8000 tab — link resolving will switch on,")
        print("and that address keeps your existing closet data.")
        print("Close this window to stop resolving links.")
    else:
        url = "http://localhost:%d/index.html" % port
        print("Hanging Clozet is running at %s" % url)
        print("Image link resolving is on. Close this window to stop the server.")
        if port != 8000:
            print("")
            print("Note: browser storage is tied to the address. Closet data saved at")
            print("http://localhost:8000 is only visible there. Stop whatever is using")
            print("port 8000 (if you can) and run this launcher again to keep that data.")
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
