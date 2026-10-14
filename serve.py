#!/usr/bin/env python3
"""Serves this folder over http so the display system can be opened at localhost.

    python3 serve.py            # http://localhost:12000
    python3 serve.py 8080       # pick your own port

Then open:

    http://localhost:12000/console.html   the control room (operator's screen)
    http://localhost:12000/display.html   the projection (church screen)
    http://localhost:12000/                a small page linking to both

Both pages must be served from the same origin: they share the songs and
settings in localStorage and the background photo in IndexedDB, and they talk
to each other over a BroadcastChannel, none of which works across file://.

Opening display.html straight off disk (file:///…) still gives you a working
clock and countdown as a standalone screen. Scripture and lyrics need a
console to drive them — the console holds the Bible text and sends it over,
so there is nothing off-disk for the display to render on its own. This
server is the tidier option: no CORS quirks, and the console can reach it.

The webpage panel fetches its page through this server (see /proxy below). A
browser refuses to frame a page whose server sends X-Frame-Options or a
frame-ancestors CSP — which is most of the web — so the console asks this
server to fetch the page instead, drop those headers, and hand it back from
the same origin. That is the only way an arbitrary link can appear on the
glass panel.
"""

import functools
import html
import http.server
import ipaddress
import os
import pathlib
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_PORT = 12000
PROXY_PATH = "/proxy"
MAX_PROXY_BYTES = 12 * 1024 * 1024
PROXY_TIMEOUT = 20
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 EWC-Display"
)

# The proxy can reach any host this machine can, so by default it refuses
# private, loopback and link-local addresses — otherwise anyone who can reach
# this server could use it to probe the local network. Set
# EWC_PROXY_ALLOW_PRIVATE=1 to fetch intranet pages on purpose.
ALLOW_PRIVATE = os.environ.get("EWC_PROXY_ALLOW_PRIVATE", "").strip() not in ("", "0", "false", "False")

_BASE_TAG_RE = re.compile(rb"<base\b[^>]*>", re.I)
_META_CSP_RE = re.compile(
    rb"<meta[^>]+http-equiv\s*=\s*[\"']?\s*content-security-policy[\"']?[^>]*>", re.I
)
_META_XFO_RE = re.compile(
    rb"<meta[^>]+http-equiv\s*=\s*[\"']?\s*x-frame-options[\"']?[^>]*>", re.I
)
_HEAD_TAG_RE = re.compile(rb"<head\b[^>]*>", re.I)
_HTML_TAG_RE = re.compile(rb"<html\b[^>]*>", re.I)


def _host_is_public(host: str) -> bool:
    """True only when every address a host resolves to is a global one."""
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    seen = False
    for info in infos:
        address = info[4][0].split("%", 1)[0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return False
        seen = True
        if not ip.is_global:
            return False
    return seen


def _rewrite_html(body: bytes, document_url: str) -> bytes:
    """Makes a fetched page usable from our own origin.

    A <base> pointing at the real document URL is what makes every relative
    asset and link resolve to the site it came from rather than to us; the
    meta CSP and X-Frame-Options tags are dropped for the same reason the
    response headers are.
    """
    base_tag = ('<base href="%s">' % html.escape(document_url, quote=True)).encode("ascii")
    body = _META_CSP_RE.sub(b"", body)
    body = _META_XFO_RE.sub(b"", body)
    body = _BASE_TAG_RE.sub(b"", body)

    head = _HEAD_TAG_RE.search(body)
    if head:
        return body[: head.end()] + base_tag + body[head.end():]
    root = _HTML_TAG_RE.search(body)
    if root:
        return body[: root.end()] + b"<head>" + base_tag + b"</head>" + body[root.end():]
    return b"<head>" + base_tag + b"</head>" + body


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files, plus the /proxy endpoint the webpage panel needs."""

    def do_GET(self):  # noqa: N802 (http.server naming)
        if urllib.parse.urlparse(self.path).path == PROXY_PATH:
            self._handle_proxy()
            return
        super().do_GET()

    # ------------------------------------------------------------------ proxy

    def _write(self, data: bytes) -> None:
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _proxy_error(self, status: int, message: str) -> None:
        page = (
            "<!doctype html><meta charset=\"utf-8\">"
            "<title>Cannot show this page</title>"
            "<style>"
            "html,body{height:100%;margin:0}"
            "body{font:16px/1.6 system-ui,-apple-system,sans-serif;background:#0b1533;"
            "color:#f8f9fd;display:flex;align-items:center;justify-content:center;text-align:center}"
            "div{max-width:34rem;padding:2rem}"
            "b{display:block;margin-bottom:.6rem;font-size:1.1rem;color:#ffc24b}"
            "</style>"
            "<div><b>Cannot show this page</b>%s</div>" % html.escape(message)
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write(page)

    def _handle_proxy(self) -> None:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = (query.get("url") or [""])[0].strip()

        parsed = urllib.parse.urlparse(target)
        if not target or parsed.scheme not in ("http", "https") or not parsed.hostname:
            self._proxy_error(400, "Enter an address starting with http:// or https://")
            return
        if not ALLOW_PRIVATE and not _host_is_public(parsed.hostname):
            self._proxy_error(
                403,
                "That address is on a private or local network, which this server will "
                "not fetch. Start the server with EWC_PROXY_ALLOW_PRIVATE=1 if you "
                "really do need an intranet page.",
            )
            return

        request = urllib.request.Request(
            target,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-GB,en;q=0.9",
                "Accept-Encoding": "identity",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=PROXY_TIMEOUT) as response:
                final_url = response.geturl()
                final_host = urllib.parse.urlparse(final_url).hostname or ""
                if not ALLOW_PRIVATE and not _host_is_public(final_host):
                    self._proxy_error(403, "That address redirected to a private network.")
                    return
                content_type = response.headers.get("Content-Type", "text/html")
                body = response.read(MAX_PROXY_BYTES + 1)
        except urllib.error.HTTPError as exc:
            self._proxy_error(502, "The site answered %s %s." % (exc.code, exc.reason))
            return
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError, ValueError) as exc:
            self._proxy_error(502, "Could not reach that address (%s)." % html.escape(str(exc)))
            return

        if len(body) > MAX_PROXY_BYTES:
            body = body[:MAX_PROXY_BYTES]

        lowered = content_type.lower()
        if "html" in lowered or "xml" in lowered:
            body = _rewrite_html(body, final_url)

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self._write(body)


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    handler = functools.partial(
        Handler,
        directory=str(pathlib.Path(__file__).resolve().parent),
    )
    print(f"Control room  http://localhost:{port}/console.html")
    print(f"Display       http://localhost:{port}/display.html")
    print("Ctrl-C to stop")
    http.server.ThreadingHTTPServer(("0.0.0.0", port), handler).serve_forever()


if __name__ == "__main__":
    main()
